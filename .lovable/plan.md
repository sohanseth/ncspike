1. Refactor the workspace shell in `src/components/workspace/MainApp.tsx` so the viewport uses one clear scroll strategy: a fixed top bar with a dedicated content region below it, and no competing nested wrappers that trap height.

2. Make `HomeCanvas` the actual vertical scroll container for the home screen by removing the remaining clipping constraints around it and ensuring its parent chain has `min-h-0` where needed.

3. Reduce the chance of top/bottom clipping by adjusting the home canvas spacing and container sizing to match the attached design at the current tablet-sized viewport (791x659), while preserving the current glassmorphic styling.

4. Verify the same fix does not break the other workspace views (`mindmap`, `memory`, `signals`, `tasks`) since they share the same shell and several also rely on internal scrolling.

5. Re-test the workspace at the current viewport and confirm:
   - the greeting bar remains visible at the top
   - the bottom cards can be reached by scrolling
   - no part of the page is visually cut off at the top or bottom
   - horizontal overflow remains limited to the intended bento area only

Technical details
- Current likely fault line: `MainApp` still combines a viewport-locked root with nested `overflow-hidden` wrappers, so the home content can exceed the visible region without the browser getting a usable scroll target.
- Files to update: primarily `src/components/workspace/MainApp.tsx`; `src/styles.css` only if a shared utility is needed.
- Implementation approach: simplify the shell first, then keep exactly one vertical scroll owner for the home screen.