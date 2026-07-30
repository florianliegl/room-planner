# Room Planner

A local-first room planning web app for drawing flat outlines, inner walls, rooms, measurements, and furniture directly in the browser.

The app is intended for quick apartment and room layout planning: draw the outside walls, set the scale from the real flat area, add inner walls, define rooms, and place simple furniture objects.

## Features

- Import a PNG, JPG, WebP, or SVG floor plan as a background.
- Draw the outer flat walls, then calibrate the scale from the total flat area.
- Draw inner walls with snapping to existing wall corners and wall segments.
- Double-click inside an enclosed wall area to create a wall-linked room, or use manual room drawing for custom shapes.
- Show room areas, wall dimensions, and ruler measurements.
- Place common furniture and openings such as beds, sofas, tables, doors, and windows.
- Move, resize, rotate, rename, and recolor objects.
- Doors and windows snap to nearby walls and fade the wall segment behind them.
- Switch to a live 3D view with orbit controls, camera presets, and an eye-level walkthrough.
- Configure real wall height and separate outer/inner wall thicknesses.
- Preview simple procedural 3D furniture and true door/window openings.
- Export print-ready 3MF or STL models with automatic bed fitting or an exact manual scale.
- Choose low-profile or scaled-height walls, real or material-saving thickness, floor/no floor, and loose or fused furniture.
- Automatically split oversized prints into named parts with adjustable friction-fit tongue-and-slot connectors.
- Autosave the current project in the browser.
- Save/load editable project JSON and export the current plan as PNG.

## Getting Started

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Expose it on the local network:

```bash
npm run dev -- --host 0.0.0.0
```

Build for production:

```bash
npm run build
```

Preview the production build:

```bash
npm run preview
```

## Basic Workflow

1. Use **Plan** to import a background floor plan if you have one.
2. Choose **Flat outline** and click around the outside walls. Click near the first point or use **Close outline** to close the flat.
3. Enter the whole flat area in square meters and press **Set** to calibrate the plan.
4. Choose **Inner wall** to draw partition walls. Use **Stop wall** to end the current wall chain while staying in the wall tool.
5. Double-click inside an enclosed area to create a room. Room areas update when the walls move.
6. Add furniture from the object presets, then drag, resize, or rotate it on the plan.
7. Use **Save** for editable JSON backups and **PNG** or **Export** for an image.
8. Switch the workspace to **3D** to orbit around the plan or enter walkthrough mode.
9. Choose **3D Print** to select the bed, scale, wall, floor, furniture, connector, and output-format settings.

## License

MIT License. See [LICENSE](LICENSE).
