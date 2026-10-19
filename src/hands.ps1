# ATRI 桌面端的“手”：主进程开着它，一行一个 JSON 命令从标准输入进来，一行一个 JSON 结果从标准输出回去。
# 只在用户勾了“允许她用电脑”时才开。能做的：移动和点击鼠标、滚动、打字、按键、列出前台窗口里能点的控件、
# 报告“真人”多久没动鼠标键盘（系统级输入监听：Windows 给程序模拟的输入打了标记，没标记的就是用户自己在动）。
# 坐标都是屏幕物理像素（进程声明了按显示器感知 DPI）。
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class AtriHands {
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
    [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
    delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);

    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint LEFTDOWN = 0x02, LEFTUP = 0x04, RIGHTDOWN = 0x08, RIGHTUP = 0x10, WHEEL = 0x800;
    const uint KEYUP = 0x02, UNICODE = 0x04;
    static HookProc mouseHook, keyHook;  // 留着引用，不被回收
    static long lastPhysical = Stopwatch.GetTimestamp();

    public static void Start() {
        SetProcessDpiAwarenessContext(new IntPtr(-4));  // 按显示器感知 DPI：坐标都是物理像素
        var thread = new Thread(() => {
            mouseHook = (code, w, l) => { if (code >= 0 && (Marshal.ReadInt32(l, 12) & 0x01) == 0) lastPhysical = Stopwatch.GetTimestamp(); return CallNextHookEx(IntPtr.Zero, code, w, l); };
            keyHook = (code, w, l) => { if (code >= 0 && (Marshal.ReadInt32(l, 8) & 0x10) == 0) lastPhysical = Stopwatch.GetTimestamp(); return CallNextHookEx(IntPtr.Zero, code, w, l); };
            IntPtr module = GetModuleHandle(null);
            SetWindowsHookEx(14, mouseHook, module, 0);  // WH_MOUSE_LL
            SetWindowsHookEx(13, keyHook, module, 0);    // WH_KEYBOARD_LL
            MSG msg;
            while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
        });
        thread.IsBackground = true;
        thread.Start();
    }

    public static long PhysicalIdleMs() { return (Stopwatch.GetTimestamp() - lastPhysical) * 1000 / Stopwatch.Frequency; }

    static void Send(params INPUT[] inputs) { SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))); }
    static INPUT Mouse(uint flags, uint data) { var input = new INPUT { type = INPUT_MOUSE }; input.u.mi.dwFlags = flags; input.u.mi.mouseData = data; return input; }
    static INPUT Key(ushort vk, ushort scan, uint flags) { var input = new INPUT { type = INPUT_KEYBOARD }; input.u.ki.wVk = vk; input.u.ki.wScan = scan; input.u.ki.dwFlags = flags; return input; }

    public static void Move(int x, int y) { SetCursorPos(x, y); }

    public static void Click(int x, int y, bool right, int count) {
        SetCursorPos(x, y);
        Thread.Sleep(30);
        for (int i = 0; i < Math.Max(1, count); i++) {
            Send(Mouse(right ? RIGHTDOWN : LEFTDOWN, 0), Mouse(right ? RIGHTUP : LEFTUP, 0));
            Thread.Sleep(40);
        }
    }

    public static void Scroll(int x, int y, int amount) {
        SetCursorPos(x, y);
        Send(Mouse(WHEEL, unchecked((uint)(amount * 120))));
    }

    public static void Type(string text) {
        foreach (char c in text) {
            if (c == '\n') { Send(Key(0x0D, 0, 0), Key(0x0D, 0, KEYUP)); }
            else if (c != '\r') { Send(Key(0, c, UNICODE), Key(0, c, UNICODE | KEYUP)); }
            Thread.Sleep(5);
        }
    }

    public static void Keys(ushort[] codes) {
        foreach (var code in codes) Send(Key(code, 0, 0));
        Thread.Sleep(30);
        for (int i = codes.Length - 1; i >= 0; i--) Send(Key(codes[i], 0, KEYUP));
    }
}
"@
[AtriHands]::Start()

$VK = @{
  ctrl = 0x11; control = 0x11; shift = 0x10; alt = 0x12; win = 0x5B; enter = 0x0D; return = 0x0D; tab = 0x09; esc = 0x1B; escape = 0x1B
  backspace = 0x08; delete = 0x2E; del = 0x2E; space = 0x20; up = 0x26; down = 0x28; left = 0x25; right = 0x27; home = 0x24; end = 0x23
  pageup = 0x21; pagedown = 0x22; insert = 0x2D
}
foreach ($n in 1..12) { $VK["f$n"] = 0x6F + $n }

function KeyCodes([string]$combo) {
  $codes = @()
  foreach ($part in ($combo.ToLower() -split '\+')) {
    $name = $part.Trim()
    if ($VK.ContainsKey($name)) { $codes += [uint16]$VK[$name] }
    elseif ($name.Length -eq 1 -and $name -match '[a-z0-9]') { $codes += [uint16][char]$name.ToUpper() }
    else { throw "不认识的键：$name" }
  }
  return ,[uint16[]]$codes
}

function Elements([int]$max) {
  $window = [System.Windows.Automation.AutomationElement]::FromHandle([AtriHands]::GetForegroundWindow())
  if (-not $window) { return @{ window = ""; elements = @() } }
  $types = @("Button", "Edit", "Hyperlink", "MenuItem", "ListItem", "TabItem", "CheckBox", "ComboBox", "RadioButton", "TreeItem", "SplitButton", "Document")
  $conditions = foreach ($type in $types) {
    New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::$type)
  }
  $any = New-Object System.Windows.Automation.OrCondition($conditions)
  $found = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $any)
  $list = @()
  foreach ($item in $found) {
    if ($list.Count -ge $max) { break }
    try {
      $current = $item.Current
      if ($current.IsOffscreen) { continue }
      $rect = $current.BoundingRectangle
      if ($rect.IsEmpty -or $rect.Width -lt 2 -or $rect.Height -lt 2) { continue }
      $list += @{
        role = $current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
        name = [string]$current.Name
        x = [int]$rect.X; y = [int]$rect.Y; w = [int]$rect.Width; h = [int]$rect.Height
        focused = [bool]$current.HasKeyboardFocus; password = [bool]$current.IsPassword
      }
    } catch { }
  }
  return @{ window = [string]$window.Current.Name; elements = $list }
}

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::Out.WriteLine((@{ ready = $true } | ConvertTo-Json -Compress))
[Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $reply = @{}
  try {
    $command = $line | ConvertFrom-Json
    $reply.id = $command.id
    switch ($command.cmd) {
      "idle" { $reply.physical_ms = [AtriHands]::PhysicalIdleMs() }
      "move" { [AtriHands]::Move([int]$command.x, [int]$command.y) }
      "click" { [AtriHands]::Click([int]$command.x, [int]$command.y, $command.button -eq "right", [int]($(if ($command.count) { $command.count } else { 1 }))) }
      "scroll" { [AtriHands]::Scroll([int]$command.x, [int]$command.y, [int]$command.amount) }
      "type" { [AtriHands]::Type([string]$command.text) }
      "keys" { [AtriHands]::Keys((KeyCodes ([string]$command.keys))) }
      "elements" { $reply += Elements ([int]$(if ($command.max) { $command.max } else { 80 })) }
      default { throw "不认识的命令：$($command.cmd)" }
    }
    $reply.ok = $true
  } catch {
    $reply.ok = $false
    $reply.error = $_.Exception.Message
  }
  [Console]::Out.WriteLine(($reply | ConvertTo-Json -Compress -Depth 5))
  [Console]::Out.Flush()
}
