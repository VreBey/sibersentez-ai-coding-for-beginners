// @ts-check
// The first screen (docs/comprehensive-roadmap-tr-2026-10-07.md B4, package 2): one primary start until there is
// something to work on. Two questions, two answers:
//   ownProject       a project of the person's own exists (checklist.js hasOwnProject). Without one, the "Got an
//                    idea?" card is the start: the next-step strip would only repeat it.
//   buildingProject  the Building has a project to show (hq-live.js projectsInOrder: registered, or found and active
//                    in the last days). Without one there is nothing to give a job to: the job row steps back, and
//                    the strip's "create a project" (or the card) is the one primary New project.
// The header's New project is always a quiet shortcut (review B1: with a project it competed with Start as a second
// primary button); the card, the strip or the job row holds the one primary start. Play is quiet whenever the Building
// is live (replaying is never the main thing to do); in the example it is what the example is for. live: the
// Building shows the person's projects (in the example its strip says it is an example); loaded: the projects are
// known. Pure.
export function firstScreenParts({ live = true, loaded = false, ownProject = false, buildingProject = ownProject } = {}) {
  const noOwn = loaded && !ownProject;
  const noBuilding = loaded && !buildingProject;
  return {
    strip: !(noOwn && live),
    jobRow: !(noBuilding && live),
    headerQuiet: true,
    playQuiet: live,
  };
}

// The strip's states where the person is needed (nextStep.js keys): its button is then the one primary action and the
// job box's Start steps back (review B1); in every other state Start is the primary one. Pure.
export const NEXT_PRIMARY = Object.freeze(new Set(['newProject', 'error', 'plan', 'result', 'waiting', 'stopped']));
export function primaryIsNext(key, hasButton = true) {
  return hasButton && NEXT_PRIMARY.has(key);
}
