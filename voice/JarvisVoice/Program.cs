// JarvisVoice — ajudante de voz do Jarvis (fala + reconhecimento) usando as APIs WinRT do Windows.
// Protocolo: linhas JSON em stdin/stdout.
//   entrada: {"cmd":"wake"} | {"cmd":"once"} | {"cmd":"stop"} | {"cmd":"speak","id":"x","text":"..."}
//   saída:   ready | state | wake | heard | mode | spoken | error
using System.Security;
using System.Text.Json;
using Windows.Globalization;
using Windows.Media.SpeechRecognition;
using Windows.Media.SpeechSynthesis;
using Windows.Storage.Streams;

static class Program
{
    // Comandos reconhecidos offline (sem ditado). Fica tudo aqui, num lugar só.
    static readonly string[] Commands =
    {
        "abre o blade dash", "abrir o blade dash", "vamos jogar", "quero jogar",
        "continuar jogo", "continuar o jogo",
        "toca rock", "toca emo", "toca punk", "toca metal", "toca pagode", "toca sertanejo",
        "liga a rádio", "toca uma música", "para a música", "parar a música", "pausa a música", "desliga a rádio",
        "notícias", "notícias de tecnologia", "notícias de geopolítica", "notícias do mundo", "notícias geek", "notícias de games", "notícias do timão",
        "como está o corinthians", "como está o timão", "próximo jogo do corinthians",
        "previsão do tempo", "como está o tempo", "clima",
        "sugere uma música", "trilha do dia",
        "briefing", "me dá um briefing",
        "minimizar", "obrigado",
    };
    static readonly string[] WakeWords = { "jarvis", "ei jarvis", "olá jarvis", "oi jarvis", "jarvis acorda" };

    static readonly object OutLock = new();
    static readonly Language PtBr = new("pt-BR");
    static SpeechRecognizer? wakeRec;
    static bool wakeWanted;
    static bool wakeRunning;
    static bool dictationOk = true;
    static readonly SemaphoreSlim Gate = new(1, 1);

    static void Emit(object o)
    {
        var s = JsonSerializer.Serialize(o);
        lock (OutLock) { Console.Out.WriteLine(s); Console.Out.Flush(); }
    }

    static async Task Main()
    {
        Console.InputEncoding = System.Text.Encoding.UTF8;
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        var voices = SpeechSynthesizer.AllVoices.Where(v => v.Language.StartsWith("pt", StringComparison.OrdinalIgnoreCase)).Select(v => v.DisplayName).ToArray();
        Emit(new { type = "ready", dictation = true, voices });

        string? line;
        while ((line = await Console.In.ReadLineAsync()) != null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            try
            {
                using var doc = JsonDocument.Parse(line);
                var root = doc.RootElement;
                var cmd = root.GetProperty("cmd").GetString();
                switch (cmd)
                {
                    case "wake": _ = Run(StartWake); break;
                    case "stop": _ = Run(async () => { wakeWanted = false; await StopWake(); Emit(new { type = "state", listening = "off" }); }); break;
                    case "once": _ = Run(ListenOnce); break;
                    case "speak":
                        var id = root.TryGetProperty("id", out var i) ? i.GetString() ?? "x" : "x";
                        var text = root.TryGetProperty("text", out var t) ? t.GetString() ?? "" : "";
                        _ = Speak(id, text);
                        break;
                    case "quit": return;
                }
            }
            catch (Exception ex) { Emit(new { type = "error", message = ex.Message }); }
        }
    }

    static async Task Run(Func<Task> f)
    {
        await Gate.WaitAsync();
        try { await f(); }
        catch (Exception ex) { Emit(new { type = "error", message = ex.Message }); }
        finally { Gate.Release(); }
    }

    // ---------- Palavra de ativação (contínuo, offline) ----------
    static async Task EnsureWakeRec()
    {
        if (wakeRec != null) return;
        wakeRec = new SpeechRecognizer(PtBr);
        var phrases = WakeWords.Concat(Commands.Select(c => "jarvis " + c)).ToList();
        wakeRec.Constraints.Add(new SpeechRecognitionListConstraint(phrases, "wake"));
        var comp = await wakeRec.CompileConstraintsAsync();
        if (comp.Status != SpeechRecognitionResultStatus.Success) throw new Exception("Falha ao compilar comandos: " + comp.Status);
        wakeRec.ContinuousRecognitionSession.AutoStopSilenceTimeout = TimeSpan.FromDays(1);
        wakeRec.ContinuousRecognitionSession.ResultGenerated += (_, e) =>
        {
            var r = e.Result;
            if (r.Status != SpeechRecognitionResultStatus.Success) return;
            if (r.Confidence is SpeechRecognitionConfidence.Rejected or SpeechRecognitionConfidence.Low) return;
            // Só a palavra "jarvis" é curta e dá falso positivo com barulho: exige confiança alta.
            if (WakeWords.Contains(r.Text.Trim().ToLowerInvariant()) && r.Confidence != SpeechRecognitionConfidence.High) return;
            Emit(new { type = "wake", text = r.Text, confidence = r.Confidence.ToString() });
        };
        wakeRec.ContinuousRecognitionSession.Completed += (sender, args) =>
        {
            wakeRunning = false;
            // Reinicia sozinho se ainda devia estar ouvindo (ex.: timeout, troca de microfone)
            if (wakeWanted) Task.Run(async () => { await Task.Delay(800); await Run(StartWake); });
        };
    }

    static async Task StartWake()
    {
        wakeWanted = true;
        await EnsureWakeRec();
        if (!wakeRunning)
        {
            await wakeRec!.ContinuousRecognitionSession.StartAsync();
            wakeRunning = true;
        }
        Emit(new { type = "state", listening = "wake" });
    }

    static async Task StopWake()
    {
        if (wakeRec != null && wakeRunning)
        {
            try { await wakeRec.ContinuousRecognitionSession.StopAsync(); } catch { }
            wakeRunning = false;
        }
    }

    // ---------- Uma frase livre (ditado; se não der, lista de comandos) ----------
    static async Task ListenOnce()
    {
        var resume = wakeWanted;
        wakeWanted = false;
        await StopWake();
        Emit(new { type = "state", listening = "once" });
        try
        {
            SpeechRecognitionResult? r = null;
            if (dictationOk)
            {
                try
                {
                    using var rec = new SpeechRecognizer(PtBr);
                    rec.Timeouts.InitialSilenceTimeout = TimeSpan.FromSeconds(6);
                    rec.Timeouts.EndSilenceTimeout = TimeSpan.FromSeconds(1.2);
                    rec.Constraints.Add(new SpeechRecognitionTopicConstraint(SpeechRecognitionScenario.Dictation, "ditado"));
                    var comp = await rec.CompileConstraintsAsync();
                    if (comp.Status != SpeechRecognitionResultStatus.Success) throw new Exception(comp.Status.ToString());
                    r = await rec.RecognizeAsync();
                    if (r.Status != SpeechRecognitionResultStatus.Success) throw new Exception(r.Status.ToString());
                }
                catch (Exception ex)
                {
                    // 0x80045509 = reconhecimento de fala online desativado na privacidade do Windows
                    dictationOk = false;
                    r = null;
                    Emit(new { type = "mode", dictation = false, reason = ex.Message });
                }
            }
            if (r == null)
            {
                using var rec = new SpeechRecognizer(PtBr);
                rec.Timeouts.InitialSilenceTimeout = TimeSpan.FromSeconds(6);
                rec.Timeouts.EndSilenceTimeout = TimeSpan.FromSeconds(0.8);
                rec.Constraints.Add(new SpeechRecognitionListConstraint(Commands, "cmds"));
                await rec.CompileConstraintsAsync();
                r = await rec.RecognizeAsync();
            }
            var ok = r.Status == SpeechRecognitionResultStatus.Success && r.Confidence != SpeechRecognitionConfidence.Rejected && !string.IsNullOrWhiteSpace(r.Text);
            Emit(new { type = "heard", text = ok ? r.Text : "", confidence = r.Confidence.ToString(), dictation = dictationOk });
        }
        finally
        {
            if (resume) await StartWake();
            else Emit(new { type = "state", listening = "off" });
        }
    }

    // ---------- Fala ----------
    static SpeechSynthesizer? synth;
    static readonly SemaphoreSlim SpeakGate = new(1, 1);

    static async Task Speak(string id, string text)
    {
        await SpeakGate.WaitAsync();
        try
        {
            if (synth == null)
            {
                synth = new SpeechSynthesizer();
                var pt = SpeechSynthesizer.AllVoices.Where(v => v.Language.Equals("pt-BR", StringComparison.OrdinalIgnoreCase)).ToList();
                var voice = pt.FirstOrDefault(v => v.DisplayName.Contains("Daniel", StringComparison.OrdinalIgnoreCase))
                            ?? pt.FirstOrDefault(v => v.Gender == VoiceGender.Male) ?? pt.FirstOrDefault();
                if (voice != null) synth.Voice = voice;
            }
            var ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='pt-BR'>" +
                       $"<prosody rate='+5%' pitch='-6%'>{SecurityElement.Escape(text)}</prosody></speak>";
            using var stream = await synth.SynthesizeSsmlToStreamAsync(ssml);
            var bytes = new byte[stream.Size];
            using (var reader = new DataReader(stream.GetInputStreamAt(0)))
            {
                await reader.LoadAsync((uint)stream.Size);
                reader.ReadBytes(bytes);
            }
            var dir = Path.Combine(Path.GetTempPath(), "jarvis-tts");
            Directory.CreateDirectory(dir);
            var safeId = string.Concat(id.Where(char.IsLetterOrDigit));
            if (safeId.Length == 0) safeId = "x";
            var file = Path.Combine(dir, safeId + ".wav");
            await File.WriteAllBytesAsync(file, bytes);
            Emit(new { type = "spoken", id, file, voice = synth.Voice.DisplayName });
        }
        catch (Exception ex) { Emit(new { type = "error", id, message = "Falha ao falar: " + ex.Message }); }
        finally { SpeakGate.Release(); }
    }
}
