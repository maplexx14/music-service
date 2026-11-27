# AnimateIcons

UI icons use the official [@animateicons/react](https://animateicons.in) package. Icon geometry, variants, easing, durations, delays, and pivots come directly from the package. There are no local motion presets or forced playback durations. At the user's request, the library keeps its original Lucide book-spine icon, and like buttons use the original branded heart in `LikeHeart.jsx`.

The adapter preserves the app's SVG props, active fills, class names, sizes, and DOM refs. The package wrapper uses display: contents; SVG layout remains controlled by existing CSS. Native hover is disabled. The shared iconMotion service starts a complete animation only on pointer click or fast tap, then calls the package's stopAnimation to restore its resting state. Keyboard activation, disabled controls, reduced motion, and lite mode skip playback. Existing loader CSS handles loading indicators.

Name mappings:

| App name | AnimateIcons component |
| --- | --- |
| AlertCircle | CircleAlertIcon |
| AlertTriangle | TriangleAlertIcon |
| CheckCircle2 | CircleCheckIcon |
| Home | HouseIcon |
| Link2 | LinkIcon |
| ListMusic | ListIcon |
| Loader2 | LoaderCircleIcon |
| Mic2 | MicVocalIcon |
| MoreHorizontal | EllipsisIcon |
| Settings2 | SlidersHorizontalIcon |

Brand marks and music-service logos are separate assets. AnimateIcons is MIT licensed; the dependency includes its license.
