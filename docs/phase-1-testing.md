# Phase 1 — your testing checklist

Start from `F:\mili` with `pnpm dev`, then open [http://localhost:3000](http://localhost:3000). Both the web app and API must be running. No provider keys are needed.

## What to try

1. **Start a lesson.** Click **Explore photosynthesis**, or pick one of the four topic cards. Confirm that the workspace clearly says **Guided sample** and displays prepared learning content.
2. **Ask and select.** Type a question and press Enter. Select a board concept, ask about it, and check that the response refers to your selection. Samples follow a fixed guide; arbitrary questions do not have live AI answers.
3. **Edit the board.** Drag a card, or focus it and use arrow keys. Select a card, use its pencil button, edit its note, click **Apply edit**, then **Save board**. Reload and confirm the changes remain. Unsaved changes intentionally block sending/end until saved or discarded.
4. **Review.** Open **Concepts**, select a concept, then open **Cards**. Think of an answer and flip a card. These are authored review cards; spaced scheduling and mastery scoring are later phases.
5. **Finish and return.** Click **Finish lesson**. Download the Markdown notes, return to your learning space and reopen the completed lesson. It should retain the board, conversation and cards.
6. **Try another topic.** Fractions, the solar system and circuits each have different teaching material. Lessons should not overwrite each other.
7. **Try mobile.** Narrow the browser window. Switch between **Whiteboard** and **Study tools**, send a question, and flip a card without horizontal page scrolling. The board itself can scroll to keep its cards readable.
8. **Optional deletion.** Delete a test lesson from the home page. Confirm the deletion and check that only that lesson disappears.

## Boundaries of this phase

- Samples are deterministic authored examples, not generated answers. The sample answer matcher can miss alternate correct phrasing and is not a validated assessment system.
- Session files live in `.tokai/` on this computer. Your browser stores a guest credential; clearing browser storage removes access to its sessions. The UI is not a production account system.
- There is an editable semantic concept board, not yet the complete tldraw teaching whiteboard.
- Optional server-side Gemini text and AssemblyAI HTTP speech adapters are present. Configuration flags indicate keys were supplied, not that connectivity was verified. Real credentialed behavior is part of the next phase's testing.
- Streaming speech, microphone conversations, barge-in, gesture recognition, 3D viewers, source upload, scheduling, cloud deployment and production authentication remain later phases.
- Stop-listening cancels local playback; it does not promise to stop billing for an already dispatched HTTP synthesis request.

After trying it, tell me what worked and what needs changing. We will address Phase 1 feedback before moving to Phase 2. Nothing will be pushed to GitHub until you explicitly request it.
