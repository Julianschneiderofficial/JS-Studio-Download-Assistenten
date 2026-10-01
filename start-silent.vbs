Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\julis\Desktop\Wichtige Dokumente\Programmierte Inhalte\JS Studio Download Assistenten"
WshShell.Run "cmd /c npm start", 0, False