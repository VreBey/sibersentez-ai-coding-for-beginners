---
name: game-prototype-unity
description: "Guides a first playable Unity prototype in C#: create the project in Unity Hub, set up git for Unity, write a player controller, build a tiny test scene and reach Play mode with no Console errors. Use when the idea is a game, a 2D or 3D prototype, a platformer or a game jam entry in Unity, or a Unity project needs its first playable version."
license: "MIT (see LICENSE.md)"
compatibility: "Needs Unity Hub with a Unity 6 editor, installed by the user, plus git. Written for Windows; macOS works with the usual path changes."
metadata:
  author: "SiberSentez"
  version: "0.2.0"
  sibersentez-tags: "unity, csharp, gamedev"
  sibersentez-stage: "start"
  sibersentez-keywords-tr: "oyun*, unity, platform oyunu, 2d, 3d, karakter*, düşman*, seviye*, oynanış, oyun prototipi, fps, rpg, bulmaca, game jam"
---

# Unity game prototype

Goal: a scene where the player can move and jump, with no red errors in the Console, saved in git. Unity is a
program with a window, so work is split: **the user clicks in the Unity Editor, you write scripts and files**. Say
clearly which step is whose. Common errors and the full script are in [reference.md](reference.md).

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.

## 1. Check (user)

- Unity Hub is installed, with the newest Unity 6 LTS editor it recommends. The editor is several gigabytes; the
  user installs it. Suggested modules: Windows Build Support, and Visual Studio or VS Code support for scripts.
- In Unity: Edit > Preferences > External Tools > External Script Editor set to their code editor, so scripts open
  with autocomplete.
- `git --version` works.

## 2. Create the project (user, in Unity Hub)

1. New project > template **Universal 2D** for a 2D game or **Universal 3D** for 3D (follow `PLAN.md`).
2. Project name: for example `Game`. Location: this project folder. Unity creates `Game/` inside it.
   A subfolder is intended: the root keeps the plan and the AI tool's folder, and Unity wants a folder of its own.
3. Wait for the first import to finish (a few minutes).

## 3. Git for Unity (you, after a yes)

- Only `Assets/`, `Packages/` and `ProjectSettings/` hold the project. Everything else the editor rebuilds.
- Write `Game/.gitignore` from the list in reference.md (Library, Temp, Obj, Logs, UserSettings, Build output,
  generated IDE files).
- Ask the user to confirm two settings (Edit > Project Settings > Editor): Version Control mode "Visible Meta Files"
  and Asset Serialization "Force Text". New projects usually have both.
- Every asset has a `.meta` file next to it. Always commit them together.
- **Move or rename assets only inside Unity's Project window**, never in File Explorer, or references break.

## 4. First playable scene

1. You create `Game/Assets/Scripts/PlayerController.cs` from reference.md. The class name must equal the file name.
   New Unity 6 projects read input through the Input System package; the script uses it.
2. The user, in the Editor (2D example):
   - Hierarchy > right click > 2D Object > Sprites > Square. Rename it `Player`.
   - Add Component > Rigidbody 2D. Under Constraints tick Freeze Rotation Z so it does not tip over.
   - Add Component > Box Collider 2D, then Add Component > Player Controller.
   - Create another Square named `Ground`, move it below the player, set Scale X to 20, add Box Collider 2D
     (no Rigidbody).
   - Save the scene (Ctrl+S).
3. The user presses Play: A/D or the arrow keys move, Space jumps. Press Play again to stop.
4. For 3D, write the 3D version (Rigidbody, Vector3, BoxCollider) the same way and tell the user which objects to add.

Warn the user once: **changes made while Play mode is running are lost when it stops.**

## 5. Verify

- Console window (Window > General > Console): zero red errors. Unity refuses to enter Play mode while scripts have
  compile errors, so fix those first.
- The player moves and jumps; nothing falls through the ground.
- Optional check without the editor window, only while the editor is closed: the batch mode command in
  reference.md compiles the project and writes a log you can read.

## 6. Save

Show `git status` (it must not list `Library/` or `Temp/`), then commit after a yes:
`git add -A`, `git commit -m "feat: first playable prototype"`. Large art or audio files later may need Git LFS;
explain it and ask before installing anything.

## What comes next

- One mechanic at a time: collect an item, reach a goal, lose on falling, restart
  (`SceneManager.LoadScene` reloads the scene).
- Playtest after every change, even for a minute.
- Keep the scope tiny until the core loop is fun. Menus, sound and art come after.
- Automated tests: Unity Test Framework (Edit Mode tests for plain C# logic), see reference.md.

## Sound, saving, a menu and a build

Add these one at a time, after the core loop is fun. The code and the editor steps for each are in reference.md:

1. **Sound**: an `AudioSource` and a sound effect on jump or pick-up; music on its own object. Ask the user for sound
   files they have the right to use.
2. **Saving**: a high score or a setting with `PlayerPrefs`; bigger saves as a small JSON file in the folder Unity
   names for it. Never write into `Assets/` from a built game.
3. **A simple menu**: a start scene with a Play button and a Quit button; both scenes must be in the build list.
4. **A build**: File > Build Profiles, Windows, add the open scenes, Build into a folder **outside** the project (or
   `Builds/`, which is git-ignored). Run the built program once and say what you saw: the editor and the build can
   differ. Version number in Project Settings > Player.
