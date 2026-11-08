# Cria o atalho "Jarvis" na Área de Trabalho (abre o app; se já estiver aberto, só traz a janela pra frente).
$dir  = Split-Path -Parent $PSScriptRoot
$desk = [Environment]::GetFolderPath('Desktop')
$s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desk 'Jarvis.lnk'))
$s.TargetPath       = Join-Path $dir 'node_modules\electron\dist\electron.exe'
$s.Arguments        = '"' + $dir + '"'
$s.WorkingDirectory = $dir
$s.IconLocation     = (Join-Path $dir 'assets\icon.ico') + ',0'
$s.Description      = 'J.A.R.V.I.S. - dashboard pessoal'
$s.Save()
"Atalho criado: " + (Join-Path $desk 'Jarvis.lnk')
