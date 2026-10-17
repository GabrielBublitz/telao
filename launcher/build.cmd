@echo off
rem Compila o Telao.exe com o compilador C# que ja vem no Windows (.NET Framework 4).
cd /d "%~dp0"
"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:exe /codepage:65001 /win32icon:telao.ico /r:System.ServiceProcess.dll /out:..\Telao.exe Telao.cs
