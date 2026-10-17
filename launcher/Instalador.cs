// Instalador do Telão (modo direto, sem playit) e desinstalador.
//   Telao-Instalador.exe     instala/atualiza (o app vai embutido como recurso "telao.zip")
//   Desinstalar-Telao.exe    mesmo código, sem o recurso: remove o Telão
// Compilado com o csc.exe do .NET Framework que já vem no Windows (veja scripts\gerar-instalador.ps1).
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading;
using Microsoft.Win32;

class Instalador
{
    const string AppName = "Telão";
    const string RegKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Telao";
    const string FirewallRule = "Telao - video";
    const string Version = "1.0";

    static bool silent;

    static int Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        silent = Has(args, "--silencioso");
        try
        {
            if (Has(args, "--firewall")) return ConfigureFirewall(Arg(args, "--firewall"), Has(args, "--remover"));
            if (Has(args, "--desinstalar") || Payload() == null) return Uninstall(args);
            return Install(args);
        }
        catch (Exception e)
        {
            Fail("Erro inesperado: " + e.Message);
            return 1;
        }
    }

    // ---------------- instalação ----------------

    static int Install(string[] args)
    {
        Console.Title = "Instalador do Telão";
        Title("Instalador do Telão");
        Console.WriteLine("  Compartilhamento de tela entre amigos, com este PC como servidor.");
        Console.WriteLine("  Modo direto: o vídeo chega pelo IP de internet deste PC (sem playit).");
        Console.WriteLine();

        if (!Environment.Is64BitOperatingSystem) { Fail("O Telão precisa do Windows 64 bits."); return 1; }

        bool noSystem = Has(args, "--sem-sistema"); // só para testes: não mexe em firewall, atalhos nem registro
        string dir = Arg(args, "--pasta") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\Telao");

        if (PortOpen(3002) && !noSystem)
        {
            Fail("O Telão está aberto. Feche a janela dele e rode o instalador de novo.");
            return 1;
        }

        Step("Instalando em " + dir);
        bool update = File.Exists(Path.Combine(dir, "Telao.exe"));
        Directory.CreateDirectory(dir);
        Extract(dir);
        Ok(update ? "Arquivos atualizados (suas salas e configurações foram mantidas)." : "Arquivos copiados.");

        string env = Path.Combine(dir, @"server\.env");
        if (!File.Exists(env))
        {
            File.WriteAllText(env, DirectModeEnv, new UTF8Encoding(false));
            Ok("Configuração do modo direto criada (porta 40000, roteador via UPnP, salas de 7 dias).");
        }
        else
        {
            Ok("Configuração existente mantida (server\\.env).");
        }

        if (!noSystem)
        {
            Step("Liberando o Telão no Firewall do Windows (o Windows vai pedir permissão)");
            if (RunElevated("--firewall \"" + dir + "\"")) Ok("Firewall liberado para o Telão.");
            else Warn("Permissão negada. Na primeira vez que abrir o Telão, o Windows vai perguntar: marque redes PRIVADAS e PÚBLICAS e clique em Permitir.");

            Step("Criando atalhos");
            string exe = Path.Combine(dir, "Telao.exe");
            Shortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppName + ".lnk"), exe, "");
            Shortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), AppName + ".lnk"), exe, "");
            Ok("Atalhos na Área de Trabalho e no menu Iniciar.");

            string startup = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), AppName + ".lnk");
            if (Ask("Iniciar o Telão automaticamente quando o Windows ligar?", false))
            {
                Shortcut(startup, exe, "--sem-navegador");
                Ok("Vai iniciar junto com o Windows.");
            }
            else if (File.Exists(startup))
            {
                File.Delete(startup);
            }

            RegisterUninstall(dir);
            Ok("Aparece em Configurações > Aplicativos (para desinstalar).");
        }

        Console.WriteLine();
        Title("Pronto!");
        Console.WriteLine("  Para usar: abra o atalho \"Telão\". Deixe a janela aberta enquanto estiver no ar.");
        Console.WriteLine("  O painel (só neste PC) abre sozinho: crie a sala e mande o link para os amigos.");
        Console.WriteLine();
        Console.WriteLine("  Importante: o roteador precisa aceitar conexões de fora.");
        Console.WriteLine("  O Telão tenta abrir a porta sozinho (UPnP). O painel mostra se deu certo;");
        Console.WriteLine("  se não der, abra no roteador UDP e TCP 40000 para este PC.");
        Console.WriteLine();
        if (!noSystem && Ask("Abrir o Telão agora?", true)) Process.Start(Path.Combine(dir, "Telao.exe"));
        Pause();
        return 0;
    }

    const string DirectModeEnv =
        "# Gerado pelo instalador do Telão: modo direto (sem playit).\r\n" +
        "# O site e a sinalização saem por um túnel HTTPS gratuito; o vídeo chega direto pela porta 40000.\r\n" +
        "HTTP_HOST=127.0.0.1\r\n" +
        "TUNNEL=cloudflared\r\n" +
        "MEDIA_UDP_PORT=40000\r\n" +
        "MEDIA_TCP_PORT=40000\r\n" +
        "MEDIA_ANNOUNCED_ADDRESS=auto\r\n" +
        "# Pede ao roteador para abrir a porta sozinho (UPnP). Se o roteador não deixar, abra UDP/TCP 40000 manualmente.\r\n" +
        "MEDIA_UPNP=auto\r\n" +
        "MEDIA_IPV6=off\r\n" +
        "ROOM_TTL_HOURS=168\r\n";

    static Stream Payload()
    {
        return Assembly.GetExecutingAssembly().GetManifestResourceStream("telao.zip");
    }

    /// Extrai o pacote (pasta "Telao/" no zip) sobre a instalação, mantendo server\.env e server\.data.
    static void Extract(string dir)
    {
        using (var zip = new ZipArchive(Payload(), ZipArchiveMode.Read))
        {
            int n = 0, total = zip.Entries.Count;
            foreach (ZipArchiveEntry e in zip.Entries)
            {
                n++;
                string rel = e.FullName.Replace('\\', '/');
                int slash = rel.IndexOf('/');
                if (slash < 0) continue;
                rel = rel.Substring(slash + 1); // tira o "Telao/"
                if (rel.Length == 0) continue;
                if (rel.StartsWith("server/.data/") || rel == "server/.env") continue;
                string target = Path.GetFullPath(Path.Combine(dir, rel.Replace('/', '\\')));
                if (!target.StartsWith(Path.GetFullPath(dir), StringComparison.OrdinalIgnoreCase)) continue; // proteção contra "../"
                if (rel.EndsWith("/")) { Directory.CreateDirectory(target); continue; }
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                e.ExtractToFile(target, true);
                if (n % 200 == 0 || n == total) Console.Write("\r    {0}/{1} arquivos", n, total);
            }
            Console.WriteLine();
        }
    }

    // ---------------- desinstalação ----------------

    static int Uninstall(string[] args)
    {
        Console.Title = "Desinstalar o Telão";
        string dir = Arg(args, "--pasta") ?? AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        Title("Desinstalar o Telão");
        Console.WriteLine("  Pasta: " + dir);
        Console.WriteLine();
        if (!File.Exists(Path.Combine(dir, "Telao.exe"))) { Fail("O Telão não foi encontrado nesta pasta."); return 1; }
        bool noSystem = Has(args, "--sem-sistema"); // só para testes: não mexe em firewall, atalhos nem registro
        if (!Has(args, "--confirmar") && !Ask("Remover o Telão deste computador (inclusive as salas salvas)?", false)) return 0;

        Step("Fechando o Telão");
        foreach (string name in new[] { "Telao", "node", "cloudflared" })
        {
            foreach (Process p in Process.GetProcessesByName(name))
            {
                try
                {
                    if (p.MainModule.FileName.StartsWith(dir, StringComparison.OrdinalIgnoreCase)) { p.Kill(); p.WaitForExit(3000); }
                }
                catch { }
            }
        }

        if (!noSystem) RemoveSystemEntries(dir);

        Step("Apagando arquivos");
        // Este programa roda de dentro da pasta: a remoção final acontece logo depois que ele fechar.
        var psi = new ProcessStartInfo("cmd.exe", "/c timeout /t 2 /nobreak >nul & rmdir /s /q \"" + dir + "\"");
        psi.WindowStyle = ProcessWindowStyle.Hidden;
        psi.CreateNoWindow = true;
        Process.Start(psi);
        Ok("Telão removido.");
        Pause();
        return 0;
    }

    static void RemoveSystemEntries(string dir)
    {
        Step("Removendo atalhos, registro e regra do firewall");
        foreach (string f in new[] {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppName + ".lnk"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), AppName + ".lnk"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), AppName + ".lnk") })
        {
            try { if (File.Exists(f)) File.Delete(f); } catch { }
        }
        try { Registry.CurrentUser.DeleteSubKeyTree(RegKey, false); } catch { }
        if (!RunElevated("--firewall \"" + dir + "\" --remover")) Warn("A regra do firewall \"" + FirewallRule + "\" ficou (permissão negada).");
    }

    // ---------------- firewall (roda como administrador) ----------------

    static int ConfigureFirewall(string dir, bool remove)
    {
        Netsh("advfirewall firewall delete rule name=\"" + FirewallRule + "\"");
        if (remove) return 0;
        string node = Path.Combine(dir, @"runtime\node.exe");
        return Netsh("advfirewall firewall add rule name=\"" + FirewallRule + "\" dir=in action=allow program=\"" + node + "\" enable=yes profile=any");
    }

    static int Netsh(string args)
    {
        var psi = new ProcessStartInfo("netsh.exe", args);
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        using (Process p = Process.Start(psi)) { p.WaitForExit(); return p.ExitCode; }
    }

    static bool RunElevated(string args)
    {
        try
        {
            var psi = new ProcessStartInfo(Assembly.GetExecutingAssembly().Location, args);
            psi.Verb = "runas";
            psi.UseShellExecute = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            using (Process p = Process.Start(psi)) { p.WaitForExit(); return p.ExitCode == 0; }
        }
        catch { return false; } // usuário recusou a permissão (UAC)
    }

    // ---------------- atalhos e registro ----------------

    static void Shortcut(string path, string target, string arguments)
    {
        Type t = Type.GetTypeFromProgID("WScript.Shell");
        object shell = Activator.CreateInstance(t);
        object lnk = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { path });
        Type lt = lnk.GetType();
        lt.InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { target });
        lt.InvokeMember("Arguments", BindingFlags.SetProperty, null, lnk, new object[] { arguments });
        lt.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk, new object[] { Path.GetDirectoryName(target) });
        lt.InvokeMember("IconLocation", BindingFlags.SetProperty, null, lnk, new object[] { target + ",0" });
        lt.InvokeMember("Description", BindingFlags.SetProperty, null, lnk, new object[] { "Telão - compartilhamento de tela entre amigos" });
        lt.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
    }

    static void RegisterUninstall(string dir)
    {
        using (RegistryKey k = Registry.CurrentUser.CreateSubKey(RegKey))
        {
            k.SetValue("DisplayName", AppName);
            k.SetValue("DisplayVersion", Version);
            k.SetValue("Publisher", AppName);
            k.SetValue("DisplayIcon", Path.Combine(dir, "Telao.exe"));
            k.SetValue("InstallLocation", dir);
            k.SetValue("UninstallString", "\"" + Path.Combine(dir, "Desinstalar-Telao.exe") + "\" --desinstalar");
            k.SetValue("NoModify", 1, RegistryValueKind.DWord);
            k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        }
    }

    // ---------------- utilidades ----------------

    static bool PortOpen(int port)
    {
        try
        {
            using (var c = new TcpClient())
            {
                IAsyncResult r = c.BeginConnect("127.0.0.1", port, null, null);
                return r.AsyncWaitHandle.WaitOne(300) && c.Connected;
            }
        }
        catch { return false; }
    }

    static bool Has(string[] args, string flag) { return Array.IndexOf(args, flag) >= 0; }

    static string Arg(string[] args, string flag)
    {
        int i = Array.IndexOf(args, flag);
        return i >= 0 && i + 1 < args.Length && !args[i + 1].StartsWith("--") ? args[i + 1] : null;
    }

    static bool Ask(string question, bool def)
    {
        if (silent) return def;
        Console.Write("  " + question + (def ? " [S/n] " : " [s/N] "));
        string a = (Console.ReadLine() ?? "").Trim().ToLowerInvariant();
        return a.Length == 0 ? def : a.StartsWith("s") || a.StartsWith("y");
    }

    static void Pause()
    {
        if (silent) return;
        Console.WriteLine("  Aperte Enter para fechar.");
        Console.ReadLine();
    }

    static void Title(string s)
    {
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine("  " + s);
        Console.WriteLine("  " + new string('=', s.Length));
        Console.ResetColor();
    }

    static void Step(string s) { Console.WriteLine(); Console.WriteLine("> " + s); }

    static void Ok(string s) { Console.ForegroundColor = ConsoleColor.Green; Console.WriteLine("  ✔ " + s); Console.ResetColor(); }

    static void Warn(string s) { Console.ForegroundColor = ConsoleColor.Yellow; Console.WriteLine("  ⚠ " + s); Console.ResetColor(); }

    static void Fail(string s)
    {
        Console.ForegroundColor = ConsoleColor.Red;
        Console.WriteLine("  ✖ " + s);
        Console.ResetColor();
        Pause();
    }
}
