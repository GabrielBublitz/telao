// Telao.exe — liga o servidor do Telão com um duplo clique.
// Janela aberta = Telão no ar. Fechar a janela (ou Ctrl+C) desliga servidor e túnel.
// Compilado com o csc.exe do .NET Framework que já vem no Windows (veja launcher\build.cmd).
using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

class Telao
{
    const int AdminPort = 3002;

    static string root;
    static string serverDir;
    static Process server;
    static volatile bool quitting;

    delegate bool ConsoleCtrlHandler(int ctrlType);
    [DllImport("kernel32.dll")]
    static extern bool SetConsoleCtrlHandler(ConsoleCtrlHandler handler, bool add);
    static ConsoleCtrlHandler ctrlHandler; // referência mantida para o coletor de lixo não liberar

    static int Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        Console.Title = "Telão — servidor (feche esta janela para desligar)";
        root = AppDomain.CurrentDomain.BaseDirectory;
        serverDir = Path.Combine(root, "server");
        bool openBrowser = Array.IndexOf(args, "--sem-navegador") < 0;

        string node = Path.Combine(root, @"runtime\node.exe");
        string cloudflared = Path.Combine(root, @"runtime\cloudflared.exe");
        string[] required = {
            node, cloudflared,
            Path.Combine(serverDir, @"node_modules\mediasoup\package.json"),
            Path.Combine(root, @"web\out\index.html"),
        };
        foreach (string f in required)
        {
            if (!File.Exists(f))
            {
                Fail("Arquivo necessário não encontrado:\n  " + f + "\nVeja o README (seção Instalação).");
                return 1;
            }
        }

        if (PortOpen(AdminPort))
        {
            Console.WriteLine("O Telão já está rodando. Abrindo o painel...");
            if (openBrowser) OpenPanel();
            Thread.Sleep(2000);
            return 0;
        }

        Banner();
        EnsurePlayit();

        ctrlHandler = OnConsoleClose;
        SetConsoleCtrlHandler(ctrlHandler, true);

        bool panelOpened = !openBrowser;
        while (!quitting)
        {
            var psi = new ProcessStartInfo(node, "src/index.js");
            psi.WorkingDirectory = serverDir;
            psi.UseShellExecute = false; // compartilha esta janela: os logs aparecem aqui
            psi.EnvironmentVariables["CLOUDFLARED_PATH"] = cloudflared;
            server = Process.Start(psi);

            if (!panelOpened)
            {
                panelOpened = true;
                new Thread(() =>
                {
                    for (int i = 0; i < 60 && !quitting; i++)
                    {
                        if (PortOpen(AdminPort)) { OpenPanel(); return; }
                        Thread.Sleep(500);
                    }
                }) { IsBackground = true }.Start();
            }

            server.WaitForExit();
            if (quitting) break;
            Console.WriteLine();
            Console.WriteLine(string.Format("O servidor parou (código {0}). Reiniciando em 3 s...", server.ExitCode));
            Thread.Sleep(3000);
        }
        StopTunnel();
        return 0;
    }

    static void Banner()
    {
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine("==============================================");
        Console.WriteLine("  TELÃO — servidor de compartilhamento de tela");
        Console.WriteLine("==============================================");
        Console.ResetColor();
        Console.WriteLine("  Painel (só neste PC): http://localhost:" + AdminPort);
        Console.WriteLine("  Deixe esta janela aberta enquanto usar.");
        Console.WriteLine("  Para desligar: feche a janela ou aperte Ctrl+C.");
        Console.WriteLine();
    }

    /// O vídeo passa pelo túnel UDP do playit.gg (sua internet usa CGNAT): garante o serviço ligado.
    static void EnsurePlayit()
    {
        try
        {
            using (var sc = new ServiceController("playitd"))
            {
                if (sc.Status != ServiceControllerStatus.Running)
                {
                    Console.WriteLine("Ligando o serviço do playit.gg...");
                    sc.Start();
                    sc.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(15));
                }
                Console.WriteLine("playit.gg: ligado (vídeo pela internet).");
            }
        }
        catch (InvalidOperationException)
        {
            Warn("playit.gg não encontrado ou sem permissão para ligar. Abra o app do playit, senão o vídeo não chega aos amigos.");
        }
        catch (System.ServiceProcess.TimeoutException)
        {
            Warn("O serviço do playit.gg demorou para ligar. Confira no app do playit.");
        }
        Console.WriteLine();
    }

    static bool OnConsoleClose(int ctrlType)
    {
        // 0 = Ctrl+C, 1 = Ctrl+Break, 2 = fechar a janela, 5/6 = logoff/desligar
        quitting = true;
        try { if (server != null && !server.HasExited) server.Kill(); } catch { }
        StopTunnel();
        return ctrlType == 0 || ctrlType == 1; // Ctrl+C: o loop principal termina normalmente
    }

    /// O túnel roda separado do servidor (para sobreviver a reinícios); ao sair do .exe, desliga também.
    static void StopTunnel()
    {
        string state = Path.Combine(serverDir, @".data\tunnel.json");
        try
        {
            if (!File.Exists(state)) return;
            Match m = Regex.Match(File.ReadAllText(state), "\"pid\"\\s*:\\s*(\\d+)");
            if (m.Success)
            {
                Process p = Process.GetProcessById(int.Parse(m.Groups[1].Value));
                if (p.ProcessName.IndexOf("cloudflared", StringComparison.OrdinalIgnoreCase) >= 0) p.Kill();
            }
            File.Delete(state);
        }
        catch { }
    }

    static bool PortOpen(int port)
    {
        try
        {
            using (var c = new TcpClient())
            {
                IAsyncResult r = c.BeginConnect("127.0.0.1", port, null, null);
                bool ok = r.AsyncWaitHandle.WaitOne(300) && c.Connected;
                return ok;
            }
        }
        catch { return false; }
    }

    static void OpenPanel()
    {
        try { Process.Start("http://localhost:" + AdminPort); } catch { }
    }

    static void Warn(string msg)
    {
        Console.ForegroundColor = ConsoleColor.Yellow;
        Console.WriteLine("⚠ " + msg);
        Console.ResetColor();
    }

    static void Fail(string msg)
    {
        Console.ForegroundColor = ConsoleColor.Red;
        Console.WriteLine(msg);
        Console.ResetColor();
        Console.WriteLine("\nAperte Enter para fechar.");
        Console.ReadLine();
    }
}
