// Tests written with Windows' own paths and programs (C:\ folders, USERPROFILE and APPDATA, .exe and .cmd files,
// Windows Terminal, cmd.exe, PowerShell, ::$ stream names): they test Windows' behaviour and run on Windows only. What
// Linux and macOS do instead is tested on every computer in test/platform*.test.mjs (plan G2).
export const WIN_ONLY = process.platform !== 'win32' && 'Windows paths and programs (Linux and macOS: test/platform*.test.mjs)';
