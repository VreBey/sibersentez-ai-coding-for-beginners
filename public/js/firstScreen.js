// The first screen (docs/comprehensive-roadmap-tr-2026-10-07.md B4, package 2): one primary start until there is
// something to work on. Two questions, two answers:
//   ownProject       a project of the person's own exists (checklist.js hasOwnProject). Without one, the "Got an
//                    idea?" card is the start: the next-step strip would only repeat it.
//   buildingProject  the Building has a project to show (hq-live.js projectsInOrder: registered, or found and active
//                    in the last days). Without one there is nothing to give a job to: the job row steps back, and
//                    the strip's "create a project" (or the card) is the one primary New project.
// The header's New project stays as a quiet shortcut while either holds. live: the Building shows the person's
// projects (in the example its strip says it is an example); loaded: the projects are known. Pure.
export function firstScreenParts({ live = true, loaded = false, ownProject = false, buildingProject = ownProject } = {}) {
  const noOwn = loaded && !ownProject;
  const noBuilding = loaded && !buildingProject;
  return {
    strip: !(noOwn && live),
    jobRow: !(noBuilding && live),
    headerQuiet: noOwn || noBuilding,
    // The example's play button: the card's "Watch the example" is the same action
    playQuiet: noOwn && live,
  };
}
