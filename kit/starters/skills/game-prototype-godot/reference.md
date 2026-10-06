# Godot game prototype: reference

Paths assume the Godot project lives in `Game/` inside the project folder. Written for Godot 4; check
https://docs.godotengine.org/ for the current names if something is not found. Indent GDScript with tabs.

## player.gd (2D movement and jump)

Save as `Game/player.gd`; every indented line starts with tab characters.

```gdscript
extends CharacterBody2D

# Values show up in the Inspector and can be changed there without editing code
@export var speed: float = 300.0
@export var jump_speed: float = -450.0

# Gravity strength comes from the project's physics settings
var gravity: float = ProjectSettings.get_setting("physics/2d/default_gravity")


func _physics_process(delta: float) -> void:
	# Pull the player down while it is in the air
	if not is_on_floor():
		velocity.y += gravity * delta

	# Jump only from the ground
	if Input.is_action_just_pressed("ui_accept") and is_on_floor():
		velocity.y = jump_speed

	# -1 for left, 1 for right, 0 for none
	var direction: float = Input.get_axis("ui_left", "ui_right")
	velocity.x = direction * speed

	# Move and slide along whatever it touches
	move_and_slide()
```

Notes: Godot reads `velocity` on the body itself; there is no argument to `move_and_slide()` in Godot 4. Values
set in the Inspector override the numbers in the code. The default actions `ui_left`, `ui_right` and `ui_accept` are
meant for menus but work for a prototype; real games add their own actions in Project Settings, Input Map.

## .gitignore (if the project dialog did not write one)

Save as `Game/.gitignore`:

```
# The editor's cache, rebuilt on open
.godot/

# Export output and logs
/build/
*.log

# Editor-specific files
.vscode/
.idea/
```

Commit `project.godot`, every `.tscn`, `.gd` and `.tres` file, the assets and their `.import` files if the project
has them. Newer Godot 4 versions also write a `.uid` file next to scripts: commit those too, so references survive.

## Checks without the editor window

Close the editor first. Find the program in the folder where the user unpacked it (for example
`C:\Tools\Godot\Godot_v4.x-stable_win64_console.exe`; the file with `console` in its name prints to the terminal).

```powershell
$godot = "C:\Tools\Godot\Godot_v4.x-stable_win64_console.exe"
& $godot --headless --path "C:\path\to\project\Game" --quit
$LASTEXITCODE
```

The project loads and quits; script errors are printed in the terminal. Exit code 0 means it loaded. `--help` lists the
options of the version in use: read it before relying on a flag. The window itself is for the user to look at.

## Common errors

| Message or symptom | Cause and fix |
|---|---|
| `Parse Error: Mixed use of tabs and spaces for indentation` or `Expected indented block` | spaces and tabs mixed. Re-write the script with tabs only. |
| `Identifier "x" not declared in the current scope` | a typo, or the variable is declared in another function. Declare it at the top of the script. |
| `Invalid call. Nonexistent function 'move_and_slide' in base 'Node2D'` | the script is on the wrong node type. The first line must be `extends CharacterBody2D` and the node must be a CharacterBody2D. |
| The player falls through the ground | the ground has no `CollisionShape2D`, or the shape has no size (a resource not set), or the layers do not match (Inspector, Collision, Layer and Mask). |
| The player floats or does not fall | gravity is not applied: check `is_on_floor()` and that the script is attached. |
| Nothing moves when keys are pressed | the script is not attached to `Player`, or the game window did not have focus; click into it. |
| `Node not found: "Sprite2D"` | the path in `get_node` or `$Sprite2D` does not match the scene tree. Use the exact node name. |
| Names from a tutorial do not exist (`KinematicBody2D`, `onready`, `export`) | they are Godot 3 names: now `CharacterBody2D`, `@onready` and `@export`; `move_and_slide()` takes no argument and `velocity` is a property. |
| Nothing happens on F5, or it asks for a scene each time | no main scene: Project Settings, Application, Run, Main Scene. |
| "Cannot open file" for a texture or scene after moving files | files were moved outside the editor. Move them back, then move them inside the FileSystem dock. |
| Merge conflicts in `.tscn` files | two people changed one scene. One person per scene at a time; split big scenes into smaller ones. |
| Everything looks blurry in a pixel-art game | Project Settings, Rendering, Textures, Default Texture Filter: Nearest. |

## Next steps that stay small

- Restart: `get_tree().reload_current_scene()` in a function called when the player falls below a height.
- Camera: add a `Camera2D` as a child of `Player`; it follows the player.
- Sound: an `AudioStreamPlayer` node with a sound file in its Stream slot; call `play()` from the script.
- Saving: write a small file with `FileAccess` under `user://` (a safe folder the engine chooses); never write into the
  project folder from a built game.
- Keep game rules in plain scripts that do not touch the scene tree, so they can be tried on their own.
