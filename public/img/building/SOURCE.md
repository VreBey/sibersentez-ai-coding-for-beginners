# Where the building's images come from

The workshop building (docs/hq.md). The older drawings (the Studio Pro sprites and the six-floor `hq-modern.png`)
were removed on 2026-10-01; they stay in the git history.

## hq-tower.png, hq-rear.png, hq-activity.png (the approved workshop, 2026-10-01)

From the user's "SiberSentez Bina Onayli" package (qa/chatgpt-tasarim, step 6: an interactive prototype made with
ChatGPT from the prompt in `6-bina-etkilesim/PROMPT.md`, images made with OpenAI image generation). The prototype
carried them inside its HTML; they were taken out unchanged.

- `hq-tower.png` (1536 × 1024): the three-floor house at dusk with empty rooms, the lift on the right and the sign on
  the roof. The furniture and the figures are drawn over it (hq-render.js); the rooms' and seats' positions in
  `hq-scene.js` (FLOORS, ROOMS, LIFT_BOX, DOOR_XS) match this drawing, and a new drawing needs new numbers.
- `hq-rear.png` (1536 × 1024): four typing frames seen from behind at a computer, the person above, the robot below.
- `hq-activity.png` (1024 × 1536): 4 × 4 frames: a robot and a person standing at work (server racks, easels), a
  person and a robot reading seated (the library).

## hq-actors.png (2026-09-30)

An animation atlas made with OpenAI image generation for the earlier Modern HQ view: four columns and two rows (a
seated typing person in navy clothes above, a white and graphite robot below), transparent background, same scale and
baseline, no desk. The workshop uses it while an actor stands up from a seat on its way out.

## hq-move-person.png, hq-move-robot.png, hq-chair.png (movement, 2026-10-01)

Made with OpenAI image generation for this app from the user's request (qa/chatgpt-tasarim, step 5), with the typing
atlas above as the reference for the same person and robot. Each sheet is 1024 x 1536, 4 x 4 cells of 256 x 384 on a
transparent background, the character alone (the chair apart in `hq-chair.png`, one layer for every cell): row 1 raises
a hand (waiting for you), row 2 sits down (arrives), row 3 stands up and turns to go (leaves), row 4 rests (idle). The
magenta background was keyed out, the cells aligned on one shared chair and checked (32 frames, 8 px transparent guard,
no magenta left) in the delivery's own validation. Summary of the request: the same person / robot and chair as the
typing atlas, facing right, four rows of four frames as above, no desk, no text, no floor shadow.

### Cleaned 2026-10-01: the person's walking frame

Frame 11 of `hq-move-person.png` (row 3, column 4: the walk) carried pieces of the chair beside the feet, which
walked along with the person across the building. They were removed in place: the chair's blue-grey pixels and the
dark edge pixels touching only them, then the specks no longer joined to the figure (858 pixels in all). Every pixel
outside that frame is byte-for-byte the delivery's. The robot's sheet is unchanged. Both walking frames face left
(`WALK_FACING` in hq-scene.js).
