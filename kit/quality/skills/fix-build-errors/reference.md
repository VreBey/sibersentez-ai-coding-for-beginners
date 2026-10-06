# Fix build errors: reference

Typical messages and what they usually mean. The wording changes between tool versions: match the meaning, not the
exact text. When a message is not here, read it slowly, find the first line that points into the project's own files,
and search the tool's official documentation for the error code.

## TypeScript and JavaScript

| Message (shortened) | Usually means | Usual fix |
|---|---|---|
| `Cannot find module 'x'` or `Cannot find name 'x'` | a wrong path, a missing import, or a package that is not installed | fix the path or add the import; if the package is missing, ask before `npm install` |
| `Property 'x' does not exist on type 'Y'` | the code reads a field the type does not have, often a typo | correct the name, or add the field to the type if it is real |
| `Type 'A' is not assignable to type 'B'` | a value of the wrong kind is passed or returned | convert it correctly, or fix the type that is wrong |
| `Object is possibly 'undefined'` or `'null'` | the value may be empty | check for empty first (`if (x)`), or give a default |
| `'x' is declared but its value is never read` | an unused name (a lint or strictness rule) | delete the unused name after checking it really is unused |
| `Parameter 'x' implicitly has an 'any' type` | a function argument has no type | write the type of the argument |
| `Unexpected token` | a syntax error, often a missing bracket or comma just before the reported line | look one to three lines above |
| `'await' expressions are only allowed within async functions` | `await` used in a normal function | make the function `async` |
| ESLint `no-unused-vars`, `no-undef` | unused or unknown names | same as above; a global that really exists is declared in the lint settings |
| `Module not found` (bundler) | the file or package is not where the import says | check case (`Button` and `button` differ), extension and folder |

## C# and Unity

| Message | Usually means | Usual fix |
|---|---|---|
| `CS0246` type or namespace not found | a missing `using` line or a missing assembly reference | add the `using`; in Unity check the assembly definition references |
| `CS1061` no definition for a member | the object has no such method or field | check the spelling and the object's type |
| `CS0103` name does not exist in the current context | a typo, or a variable out of scope | fix the name or move the declaration |
| `CS1002` `;` expected, `CS1513` `}` expected | a missing semicolon or bracket, usually above the reported line | look at the lines before |
| Unity shows errors that will not go away | Unity could not compile a script, so it keeps old code | fix the first console error; the others follow |

## Python

| Message | Usually means | Usual fix |
|---|---|---|
| `SyntaxError` | a missing colon, bracket or quote | look at the line and the one before |
| `IndentationError` | tabs and spaces mixed, or a wrong level | use four spaces everywhere |
| `ModuleNotFoundError` | the package is not installed in this environment (this is found when running) | ask, then install into the project's environment |
| Type checker `error:` lines | the annotation and the value disagree | fix the annotation or the value |

## The build tool itself

| Symptom | Fix |
|---|---|
| Everything fails right after pulling or updating | dependencies changed: run the install command again (ask first) |
| An error mentions two versions of the same package | a version mismatch: show it to the user and ask before changing versions |
| Works on another computer | different tool versions: compare `node --version` or the runtime version with the project's notes |
| Old output keeps appearing | a stale cache or build folder; deleting it needs a yes |
