# Tesla Dashcam Viewer

Local browser-based viewer for Tesla dashcam event folders with:

- all six camera views visible at once
- front view emphasized in the layout
- SEI metadata decoding from the MP4 files themselves
- a master-view export that composites the cameras and overlays drive-state metadata

## Run

```bash
npm install
npm start
```

Then open [http://localhost:3088](http://localhost:3088).

Optional:

```bash
export MAPBOX_ACCESS_TOKEN=your_token_here
```

With a token, the viewer and export mini-map use a Mapbox basemap. Without one, the app falls back to a locally rendered route trace built from the embedded GPS data.

## Notes

- The app expects Tesla-style event folders in the project root, like `2026-03-28_14-41-47/`.
- Telemetry is decoded from the front camera clip for each segment and aligned to the event timeline.
- Exported composites are written to `exports/<event-id>-master.mp4`.
- SEI metadata may be absent on clips that do not contain Tesla telemetry.
