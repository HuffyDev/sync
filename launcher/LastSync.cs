// LASTSYNC.exe — a tiny Windows launcher. It starts the bundled Node runtime
// with the LASTSYNC server, keeps your data next to the program (so it travels
// on a USB drive), and opens http://localhost:8787 in your browser.
// Build: csc /nologo /target:exe /out:LASTSYNC.exe LastSync.cs
using System;
using System.Diagnostics;
using System.IO;

class LastSync
{
    static int Main(string[] args)
    {
        Console.Title = "LASTSYNC";
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string node = Path.Combine(dir, "runtime", "node.exe");
        string server = Path.Combine(dir, "app", "server", "index.js");
        if (!File.Exists(node) || !File.Exists(server))
        {
            Console.WriteLine("LASTSYNC is missing some of its files.");
            Console.WriteLine("Unzip the whole LASTSYNC folder again, then open LASTSYNC.exe from inside it.");
            Console.WriteLine();
            Console.WriteLine("Press any key to close.");
            Console.ReadKey();
            return 1;
        }

        var psi = new ProcessStartInfo(node, "\"" + server + "\"");
        psi.UseShellExecute = false;
        psi.WorkingDirectory = dir;
        psi.EnvironmentVariables["LASTSYNC_OPEN"] = "1";
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("LASTSYNC_DATA")))
            psi.EnvironmentVariables["LASTSYNC_DATA"] = Path.Combine(dir, "data");

        try
        {
            using (Process p = Process.Start(psi))
            {
                p.WaitForExit();
                if (p.ExitCode != 0)
                {
                    Console.WriteLine();
                    Console.WriteLine("LASTSYNC stopped with an error. Press any key to close.");
                    Console.ReadKey();
                }
                return p.ExitCode;
            }
        }
        catch (Exception e)
        {
            Console.WriteLine("Could not start LASTSYNC: " + e.Message);
            Console.WriteLine("Press any key to close.");
            Console.ReadKey();
            return 1;
        }
    }
}
