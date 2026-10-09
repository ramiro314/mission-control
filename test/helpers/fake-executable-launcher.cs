// The win32 half of `test/helpers/fake-executable.ts`: a console program copied beside a fake's
// script as `<script>.exe`, so the product starts the fake the way it starts any Windows tool.
//
// It reads `<script>.launch` beside itself (an interpreter path, then the arguments that come
// before the caller's own) and runs that command with the caller's argument text appended
// exactly as it arrived, so the script receives the argv the product passed. It shares this
// process's standard handles, and exits with the script's exit code.
//
// The script runs in a job object that closes with this process, so killing the launcher kills
// the script, as killing a fake kills the script itself on POSIX. Processes the script starts
// leave the job, so they outlive it as they would on POSIX.
//
// The script always starts with `SystemRoot` naming the real Windows directory. A fixture moves
// `SystemRoot` to point the product at a fake system tool (the PowerShell that reads PATH), and
// Node aborts at startup, before the script runs, when `SystemRoot` names anything else.
//
// Written for the C# 5 compiler that ships with the .NET Framework in every Windows install.
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

static class FakeExecutableLauncher
{
    const uint CREATE_SUSPENDED = 0x00000004;
    const int STARTF_USESTDHANDLES = 0x00000100;
    const uint HANDLE_FLAG_INHERIT = 0x00000001;
    const uint INFINITE = 0xFFFFFFFF;
    const int STD_INPUT_HANDLE = -10;
    const int STD_OUTPUT_HANDLE = -11;
    const int STD_ERROR_HANDLE = -12;
    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK = 0x00001000;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessW(
        string lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr GetCommandLineW();

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(
        IntPtr hJob,
        int infoClass,
        ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION lpInfo,
        uint cbInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr hThread);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    static int Main()
    {
        string self = System.Reflection.Assembly.GetEntryAssembly().Location;
        if (!self.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
        {
            return Fail("fake executable launcher: unexpected name " + self);
        }
        string sidecar = self.Substring(0, self.Length - 4) + ".launch";
        string[] prefix;
        try
        {
            prefix = File.ReadAllLines(sidecar, Encoding.UTF8);
        }
        catch (Exception error)
        {
            return Fail("fake executable launcher: cannot read " + sidecar + ": " + error.Message);
        }
        if (prefix.Length == 0 || prefix[0].Length == 0)
        {
            return Fail("fake executable launcher: " + sidecar + " names no interpreter");
        }

        StringBuilder commandLine = new StringBuilder();
        foreach (string argument in prefix)
        {
            if (commandLine.Length > 0) commandLine.Append(' ');
            AppendQuoted(commandLine, argument);
        }
        string rest = ArgumentsAfterProgramName(Marshal.PtrToStringUni(GetCommandLineW()));
        if (rest.Length > 0) commandLine.Append(' ').Append(rest);

        // The Windows directory as the system reports it, not as `SystemRoot` says. The child
        // inherits this process's environment, so setting it here is enough.
        Environment.SetEnvironmentVariable("SystemRoot",
            Environment.GetFolderPath(Environment.SpecialFolder.Windows));

        STARTUPINFO startup = new STARTUPINFO();
        startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = InheritableStdHandle(STD_INPUT_HANDLE);
        startup.hStdOutput = InheritableStdHandle(STD_OUTPUT_HANDLE);
        startup.hStdError = InheritableStdHandle(STD_ERROR_HANDLE);

        PROCESS_INFORMATION child;
        if (!CreateProcessW(prefix[0], commandLine, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED,
                IntPtr.Zero, null, ref startup, out child))
        {
            return Fail("fake executable launcher: cannot start " + prefix[0] + ": "
                + new Win32Exception(Marshal.GetLastWin32Error()).Message);
        }

        // Best effort: without the job the script still runs, it just outlives a killed launcher.
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job != IntPtr.Zero)
        {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
            uint size = (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            if (SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, size))
            {
                AssignProcessToJobObject(job, child.hProcess);
            }
        }
        ResumeThread(child.hThread);
        WaitForSingleObject(child.hProcess, INFINITE);
        uint exitCode;
        if (!GetExitCodeProcess(child.hProcess, out exitCode)) exitCode = 1;
        return unchecked((int)exitCode);
    }

    static IntPtr InheritableStdHandle(int which)
    {
        IntPtr handle = GetStdHandle(which);
        if (handle != IntPtr.Zero && handle != new IntPtr(-1))
        {
            SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        }
        return handle;
    }

    // The program name ends at the closing quote when it starts with one, otherwise at the first
    // space or tab, with no escapes either way: the rule the C runtime parses argv[0] by.
    static string ArgumentsAfterProgramName(string commandLine)
    {
        int at = 0;
        if (commandLine.Length > 0 && commandLine[0] == '"')
        {
            int close = commandLine.IndexOf('"', 1);
            at = close < 0 ? commandLine.Length : close + 1;
        }
        else
        {
            while (at < commandLine.Length && commandLine[at] != ' ' && commandLine[at] != '\t') at++;
        }
        while (at < commandLine.Length && (commandLine[at] == ' ' || commandLine[at] == '\t')) at++;
        return commandLine.Substring(at);
    }

    // Quotes one argument so the C runtime's argv parser reads it back unchanged.
    static void AppendQuoted(StringBuilder line, string argument)
    {
        if (argument.Length > 0 && argument.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0)
        {
            line.Append(argument);
            return;
        }
        line.Append('"');
        int backslashes = 0;
        foreach (char c in argument)
        {
            if (c == '\\')
            {
                backslashes++;
                continue;
            }
            if (c == '"')
            {
                line.Append('\\', backslashes * 2 + 1);
            }
            else
            {
                line.Append('\\', backslashes);
            }
            backslashes = 0;
            line.Append(c);
        }
        line.Append('\\', backslashes * 2);
        line.Append('"');
    }

    static int Fail(string message)
    {
        Console.Error.WriteLine(message);
        return 127;
    }
}
