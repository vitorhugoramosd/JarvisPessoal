// JarvisVoice — ajudante de voz do Jarvis (fala + reconhecimento) usando as APIs WinRT do Windows.
// Protocolo: linhas JSON em stdin/stdout.
//   entrada: {"cmd":"wake"} | {"cmd":"once"} | {"cmd":"stop"} | {"cmd":"speak","id":"x","text":"..."}
//   saída:   ready | state | wake | heard | mode | spoken | error | debug
//
// Arquitetura da escuta: UM reconhecedor contínuo (lista de comandos, offline) que fica sempre ligado.
// Nunca é parado para ouvir um comando — parar/religar a sessão do Windows às vezes trava.
//  - Normal: só aceita frases que começam com "jarvis" (evento "wake").
//  - "once" (botão do microfone): por alguns segundos aceita o próximo comando mesmo sem "jarvis" (evento "heard").
using System.Security;
using System.Text.Json;
using Windows.Globalization;
using Windows.Media.SpeechRecognition;
using Windows.Media.SpeechSynthesis;
using Windows.Storage.Streams;

static class Program
{
    // Comandos reconhecidos offline. Fica tudo aqui, num lugar só.
    static readonly string[] Commands =
    {
        "abre o blade dash", "abrir o blade dash", "abre o jogo", "vamos jogar", "quero jogar", "modo jogo",
        "continuar jogo", "continuar o jogo", "continua o jogo",
        "toca rock", "toca emo", "toca punk", "toca metal", "toca pagode", "toca sertanejo",
        "liga a rádio", "toca uma música", "para a música", "parar a música", "pausa a música", "desliga a rádio", "para a rádio",
        "notícias", "notícias de tecnologia", "notícias de geopolítica", "notícias do mundo", "notícias geek", "notícias de games", "notícias do timão",
        "como está o corinthians", "como está o timão", "próximo jogo do corinthians", "corinthians", "timão",
        "previsão do tempo", "como está o tempo", "clima", "vai chover",
        "sugere uma música", "trilha do dia",
        "briefing", "me dá um briefing", "resumo do dia",
        "minimizar", "obrigado", "valeu",
    };
    static readonly string[] WakeWords = { "jarvis", "ei jarvis", "olá jarvis", "oi jarvis", "fala jarvis", "jarvis acorda" };
    static readonly TimeSpan ArmWindow = TimeSpan.FromSeconds(8);

    static readonly object OutLock = new();
    static readonly object StateLock = new();
    static readonly Language PtBr = new("pt-BR");

    static SpeechRecognizer? rec;
    static bool wakeWanted;          // o usuário quer a palavra "Jarvis" sempre ativa
    static bool running;             // a sessão contínua está rodando
    static DateTime armedUntil = DateTime.MinValue;
    static int armSeq;               // invalida temporizadores antigos
    static bool dictationOk = true;  // ditado livre (depende da privacidade do Windows)
    static DateTime lastAudio = DateTime.UtcNow; // último resultado do reconhecedor (até ruído rejeitado): prova que o áudio está chegando
    static readonly TimeSpan DeafAfter = TimeSpan.FromMinutes(3);
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
        dictationOk = OnlineSpeechAccepted();
        Emit(new { type = "ready", dictation = dictationOk, voices });
        _ = Task.Run(Watchdog);

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
                    case "wake": wakeWanted = true; _ = Run(EnsureRunning, "wake"); EmitState(); break;
                    case "stop": wakeWanted = false; _ = Run(StopIfIdle, "stop"); EmitState(); break;
                    case "once": _ = Run(Arm, "once"); break;
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

    // Ditado livre precisa de "Reconhecimento de fala online" ligado (Configurações › Privacidade › Fala).
    static bool OnlineSpeechAccepted()
    {
        try
        {
            using var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Speech_OneCore\Settings\OnlineSpeechPrivacy");
            return k?.GetValue("HasAccepted") is int v && v == 1;
        }
        catch { return false; }
    }

    // Executa uma operação por vez, com limite de tempo: nada pode travar a fila para sempre.
    static async Task Run(Func<Task> f, string what)
    {
        if (!await Gate.WaitAsync(TimeSpan.FromSeconds(10))) { Emit(new { type = "error", message = "fila de voz ocupada (" + what + ")" }); return; }
        try
        {
            var task = f();
            if (await Task.WhenAny(task, Task.Delay(TimeSpan.FromSeconds(8))) != task)
            {
                Emit(new { type = "error", message = "operação de voz demorou demais: " + what });
                ResetRecognizer();
            }
            else await task;
        }
        catch (Exception ex) { Emit(new { type = "error", message = ex.Message }); ResetRecognizer(); }
        finally { Gate.Release(); }
    }

    static bool Armed => DateTime.UtcNow < armedUntil;

    // A sessão contínua do Windows às vezes fica "surda" (para de receber áudio sem avisar).
    // Se passar muito tempo sem nenhum resultado (nem ruído), recria o reconhecedor.
    static async Task Watchdog()
    {
        while (true)
        {
            await Task.Delay(TimeSpan.FromSeconds(30));
            if (running && (wakeWanted || Armed) && DateTime.UtcNow - lastAudio > DeafAfter)
                await Recycle("sem-audio-ha-" + (int)(DateTime.UtcNow - lastAudio).TotalSeconds + "s");
        }
    }

    static async Task Recycle(string why)
    {
        Emit(new { type = "debug", what = "reiniciando-escuta", why });
        await Run(async () => { ResetRecognizer(); lastAudio = DateTime.UtcNow; if (wakeWanted || Armed) await EnsureRunning(); }, "reciclar");
    }

    static void EmitState() =>
        Emit(new { type = "state", listening = Armed ? "once" : (wakeWanted ? "wake" : "off") });

    // ---------- Reconhecedor contínuo ----------
    static void ResetRecognizer()
    {
        var r = rec;
        rec = null;
        running = false;
        try { r?.Dispose(); } catch { }
    }

    static async Task EnsureRecognizer()
    {
        if (rec != null) return;
        var r = new SpeechRecognizer(PtBr);
        var phrases = WakeWords.Concat(Commands).Concat(Commands.Select(c => "jarvis " + c)).Distinct().ToList();
        r.Constraints.Add(new SpeechRecognitionListConstraint(phrases, "comandos"));
        var comp = await r.CompileConstraintsAsync();
        if (comp.Status != SpeechRecognitionResultStatus.Success) { r.Dispose(); throw new Exception("Falha ao compilar comandos: " + comp.Status); }
        r.ContinuousRecognitionSession.AutoStopSilenceTimeout = TimeSpan.FromDays(1);
        r.ContinuousRecognitionSession.ResultGenerated += (_, e) => OnResult(e.Result);
        r.ContinuousRecognitionSession.Completed += (s, a) =>
        {
            if (!ReferenceEquals(rec?.ContinuousRecognitionSession, s)) return;
            running = false;
            Emit(new { type = "debug", what = "sessao-terminou", status = a.Status.ToString() });
            // religa sozinho se ainda devia estar ouvindo (timeout, troca de microfone…)
            if (wakeWanted || Armed) _ = Task.Run(async () => { await Task.Delay(600); await Run(EnsureRunning, "religar"); });
        };
        rec = r;
    }

    static async Task EnsureRunning()
    {
        await EnsureRecognizer();
        if (running) return;
        await rec!.ContinuousRecognitionSession.StartAsync();
        running = true;
        lastAudio = DateTime.UtcNow;
    }

    // Para a sessão só se ninguém mais precisa dela. Usa Cancel (não Stop) e, se travar, descarta o reconhecedor.
    static async Task StopIfIdle()
    {
        if (wakeWanted || Armed || rec == null || !running) return;
        var task = rec.ContinuousRecognitionSession.CancelAsync().AsTask();
        if (await Task.WhenAny(task, Task.Delay(1500)) != task) ResetRecognizer();
        running = false;
    }

    // Botão do microfone: aceita o próximo comando (com ou sem "jarvis") nos próximos segundos.
    static async Task Arm()
    {
        int my;
        lock (StateLock) { armedUntil = DateTime.UtcNow + ArmWindow; my = ++armSeq; }
        await EnsureRunning();
        EmitState();
        if (!dictationOk) Emit(new { type = "mode", dictation = false });
        _ = Task.Run(async () =>
        {
            await Task.Delay(ArmWindow + TimeSpan.FromMilliseconds(200));
            bool expired;
            lock (StateLock) { expired = my == armSeq && armedUntil != DateTime.MinValue && !Armed; if (expired) armedUntil = DateTime.MinValue; }
            if (!expired) return;
            var deaf = DateTime.UtcNow - lastAudio > ArmWindow;
            Emit(new { type = "heard", text = "", confidence = deaf ? "Deaf" : "Timeout", dictation = dictationOk });
            EmitState();
            if (deaf) await Recycle("microfone-sem-audio");
            else await Run(StopIfIdle, "fim-once");
        });
    }

    static void OnResult(SpeechRecognitionResult r)
    {
        var text = (r.Text ?? "").Trim();
        var low = text.ToLowerInvariant();
        var conf = r.Confidence;
        lastAudio = DateTime.UtcNow;
        Emit(new { type = "debug", what = "ouvido", text, confidence = conf.ToString(), armed = Armed });
        if (r.Status != SpeechRecognitionResultStatus.Success || conf == SpeechRecognitionConfidence.Rejected || text.Length == 0) return;

        bool armed;
        lock (StateLock) { armed = Armed; if (armed) { armedUntil = DateTime.MinValue; armSeq++; } }
        if (armed)
        {
            // Microfone apertado: aceita qualquer comando da lista (inclusive "jarvis" sozinho).
            Emit(new { type = "heard", text, confidence = conf.ToString(), dictation = dictationOk });
            EmitState();
            _ = Run(StopIfIdle, "fim-once");
            return;
        }

        if (!wakeWanted) return;
        // Sem o microfone: só vale se começar com "jarvis" (ou variações).
        bool hasWake = WakeWords.Any(w => low == w || low.StartsWith(w + " "));
        if (!hasWake) return;
        if (conf == SpeechRecognitionConfidence.Low) return;
        Emit(new { type = "wake", text, confidence = conf.ToString() });
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
