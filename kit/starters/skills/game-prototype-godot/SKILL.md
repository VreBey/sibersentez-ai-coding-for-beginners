---
name: game-prototype-godot
description: "Guides a first playable Godot prototype in GDScript: create the project, build a player scene, write a move and jump script, run it with no errors in the Output panel and save it in git. Use when the idea is a game, a 2D prototype or a game jam entry in Godot, or a Godot project needs its first playable version."
license: "MIT (see LICENSE.md)"
compatibility: "Needs Godot 4 (the standard version, a single downloaded program, no installer) and git. Written for Windows; macOS and Linux work with the usual path changes."
metadata:
  author: "SiberSentez"
  version: "0.1.1"
  sibersentez-checked: "2026-10-09"
  sibersentez-tags: "godot, gdscript, gamedev"
  sibersentez-stage: "start"
  sibersentez-keywords-tr: "godot, gdscript, gd script, godot ile, açık kaynak oyun motoru, hafif oyun motoru, godot oyunu, sahne ve düğüm"
---

# Godot game prototype

Goal: a scene where the player can move and jump, with no red errors in the Output panel, saved in git. Godot is a
program with a window, so work is split: **the user clicks in the Godot editor, you write scripts and files**. Say
clearly which step is whose. The full script, the ignore list and the error table are in [reference.md](reference.md).

## Ground rules

- Talk to the user in their language (Turkish if they write Turkish). Keep commands, code and file names as they are.
- Before each step, say in one plain sentence what you will do and why.
- Ask and wait for a yes before you delete, move or overwrite files, install anything, change system settings, or
  push to a remote.
- Never switch off your tool's permission prompts or safety checks, and never tell the user to.
- GDScript is indented with **tabs**. Write every script with tabs: mixed tabs and spaces are a parse error.

## 1. Check (user)

- Godot **4** (standard version, not the .NET one): downloaded from godotengine.org as a zip, unpacked into a folder
  of its own, started by double-clicking the program. There is no installer. Many tutorials online are for Godot 3,
  whose names differ: if a name from a tutorial is not found, say so (the reference lists the changes).
- `git --version` works.

## 2. Create the project (user, in Godot)

1. Project Manager, Create. Name: for example `Game`. Folder: a **new** folder `Game` inside this project folder (the
   root keeps the plan and the AI tool's folder).
2. Renderer: Compatibility is the safe, light choice for a first 2D game; Forward+ is for 3D.
3. If the dialog offers Version Control Metadata, choose Git: it writes `.gitignore` and `.gitattributes`. If not,
   you write them from the reference.
4. Wait for the editor to open. The folder `Game/` holds `project.godot`; files starting with `.godot/` are the
   editor's cache and are never committed.

## 3. First playable scene (2D)

1. The user: Scene, Other Node, `CharacterBody2D`, rename it `Player`. Add children: a `Sprite2D` (drag `icon.svg`
   from the FileSystem into its Texture slot) and a `CollisionShape2D` (in the Inspector, Shape: New RectangleShape2D,
   then drag the handles to cover the sprite). Save the scene as `player.tscn`.
2. You write `Game/player.gd` from the reference (tabs). The user attaches it: select `Player`, then the Attach Script
   button, pick the existing file.
3. The user: New Scene, Node2D named `Main`. Drag `player.tscn` into it (an instance of the player). Add a
   `StaticBody2D` named `Ground` with a `CollisionShape2D` (a wide RectangleShape2D) and a `ColorRect` or `Polygon2D`
   so the ground can be seen. Move the ground below the player. Save as `main.tscn`.
4. The user: Project, Project Settings, Application, Run, Main Scene: choose `main.tscn` (or press F5 and let Godot
   ask).

## 4. Run it

F5 runs the project (F6 runs the open scene). Arrow keys or A/D move through the built-in `ui_left` and `ui_right`
actions; Space or Enter jumps (`ui_accept`). Press the stop button or close the window to end. Warn the user once:
changes made to the running game are not saved into the scene.

## 5. Verify

- The Output panel (bottom) has no red lines; the Debugger tab shows no errors or warnings about the player.
- The player moves, jumps, lands, and does not fall through the ground.
- Optional, when the editor is closed: the engine can load the project from the command line without a window; see
  the reference. If your tool cannot do this, ask the user to run the game and say what happens.

## 6. Save

Show `git status`: `.godot/` must not be listed. Commit after a yes: `git add -A`, `git commit -m "feat: first
playable prototype"`. Large art or audio files may need Git LFS later; explain it and ask before installing anything.

## What comes next

- One mechanic at a time: collect an item, reach a goal, lose when falling, restart (`get_tree().reload_current_scene()`).
- Playtest after every change, even for a minute. Keep the scope tiny until the core loop is fun.
- Keep game rules (score, health) in small scripts of their own; they are easy to check on their own.
- A 3D prototype follows the same steps with `CharacterBody3D`, `MeshInstance3D` and `CollisionShape3D`: tell the
  user which nodes to add.

## Do not use for

- A Unity project: use `game-prototype-unity`.
- A game in the browser written as plain web code: use `web-app-starter`.
- A bug in a running game: use `debug-helper`; for a game task inside a team job, the `game-builder` agent.

## Done when

- The user pressed F5 and the player moved and jumped (they say so, or show what they saw).
- The Output panel has no red errors (quote what it shows).
- `git status` does not list `.godot/`; the commit exists after a yes.
- You told the user in one sentence what runs and how to start it again.
