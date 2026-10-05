# SiberSentez — AI coding for beginners

**Build something with AI coding tools, even if you have never written code.** A free Windows desktop app that sets up,
starts and shows Claude Code, Codex CLI, Gemini CLI and other AI coding agents for people new to coding.

**[Download for Windows](../../releases/latest)** · Website: [sibersentez.com](https://sibersentez.com) · Türkçe ve English

![SiberSentez: write the job in your own words, press Start, and watch your AI team plan, build and check it in the Building](docs/screenshots/hero.webp)

SiberSentez is for beginners who want to use an AI coding tool with the subscription they already have. It does not
bring its own AI and sends your work nowhere: it sets things up so the tool you chose can help you well, and keeps you
safe while it works.

- **Start from an idea.** Create a project and write in your own words what you want to make ("a to-do list", "a site
  for my restaurant"). SiberSentez picks a fitting starting point and the few skills that help, and explains why.
- **Say the job, press Start.** Write what you want done ("add a menu page") and press **Start**. Your AI tool starts in
  its own terminal inside the window, with your job as its first message.
- **A small team does the job.** The AI makes a plan first and waits for your approval; it builds, a separate reviewer
  checks the work, and you approve the result. **What next?** suggests the next step.
- **Undo is always there.** Before an AI tool starts, SiberSentez keeps a copy of the project named after your job; go
  back to it with one click.
- **Know what needs you.** Who is waiting for you, and what to do when the AI stops on a usage limit, a sign-in problem
  or a lost connection.
- **A full tour.** The guide walks through every step on the real screen as a simulation; nothing runs.
- **Skills and agents for beginners.** A kit of 57 skills and 16 agents, from planning to putting a site online,
  installed into a project only when you choose.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/plan.webp" alt="The lead's plan waits for your approval before any file is touched"><br><b>A plan first.</b> Nothing is touched before you approve the plan in the AI's terminal.</td>
    <td width="50%"><img src="docs/screenshots/result.webp" alt="The result is ready: open or run it, see what changed, or undo"><br><b>The result, checked.</b> Open or run it, see what changed, or undo it.</td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/tour.webp" alt="The full tour explains every step on the real screen, as a simulation"><br><b>A full tour.</b> Twelve steps on the real screen, as a simulation.</td>
    <td width="50%"><img src="docs/screenshots/skills.webp" alt="Skills and agents: the SiberSentez kit and your own library"><br><b>Skills and agents.</b> Installed into a project only when you choose.</td>
  </tr>
</table>

## Requirements

- Windows 10 or Windows 11, 64-bit. Nothing else to install: no Node.js, no administrator rights.
- An AI coding tool of your own, with its own account: Claude Code, Codex CLI, Gemini CLI, GitHub Copilot CLI,
  Cursor CLI, Qwen Code or OpenCode. SiberSentez finds the ones on your computer and says what is missing.

## Installation

1. Download `SiberSentez-Setup-<version>.exe` from **[Releases](../../releases/latest)**.
2. Run it. It installs for the current user only, into `%LOCALAPPDATA%\Programs\SiberSentez`.
3. Open **SiberSentez** from the Desktop or the Start menu.

> **"Windows protected your PC":** the installer is not code-signed yet, so Windows SmartScreen may warn the first time.
> If you downloaded it from this page, click **More info**, then **Run anyway**. Each release lists the installer's
> SHA-256 so you can check the file.

To uninstall: **Settings → Apps → Installed apps → SiberSentez → Uninstall**. Your hub folder
(`%USERPROFILE%\SiberSentez`) is kept.

## Privacy

- SiberSentez runs only on your computer. Its panel answers on `127.0.0.1` only.
- It sends nothing about you, your computer or your projects anywhere: no analytics, no ads, no account.
- It goes online in one case only: when you choose to bring skills from GitHub, and then only to GitHub.
- The AI tool you use sends what you write to its own provider, under that tool's terms.
- Before an AI tool starts, nothing is changed without your action; it never answers the AI's questions for you.

## License

SiberSentez is **free, but not open source**. It is licensed under the **SiberSentez License 1.0** ([LICENSE](LICENSE):
the Turkish text is binding, an English translation follows it):

- You may download it from the official sources, install it on your computers and use it for any personal,
  educational or commercial work. What you make with it is yours.
- You may not copy and distribute the program or its installer, change it, sell it, reverse engineer it, or present it
  as your own product. To share it, share this page or [sibersentez.com](https://sibersentez.com).
- The skills and agents it copies into your projects may be used and changed there, and stay in projects you share.

The source code is not published. The open source components it uses keep their own licences:
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Feedback and contact

- Bugs and ideas: [Issues](../../issues) (Turkish or English).
- Questions: **destek@sibersentez.com** · personal data (KVKK): **kvkk@sibersentez.com**
- Security problems: privately, see [SECURITY.md](SECURITY.md).

Required Notice: Copyright (c) 2026 Samet Nazlım (https://sibersentez.com)
