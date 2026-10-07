# Required original game data

Place the recovered, real game datasets here:

- `players.json`
- `managers.json`

Neither file was present in the repository or its history at the time of the backend audit. They have intentionally not been fabricated. The server refuses to start until both files parse and validate. These paths are not ignored by Git.

Run `npm run check:data` before deploying. Each file must contain a non-empty JSON array. Entries need `name`, `category`, `nationality`, a numeric `overall` (0–100), a non-negative integer `baseprice`, and numeric `attributes`:

- Managers: category `manager`; attributes `attacking`, `tactics`, `discipline`, `adaptability`, `motivation`, `defense`; optional `preferredFormation`.
- Players: `position`, `primary`; category `icons`, `hearts`, `young gen`, or `normal`.
- Goalkeepers: attributes `diving`, `handling`, `kicking`, `reflexes`, `speed`, `positioning`.
- Other players: attributes `pace`, `shooting`, `passing`, `dribbling`, `defending`, `physical`.

The loader reports the file and entry number when validation fails. The server does not serve these files publicly. Objects under `test/` are minimal protocol test doubles, not game datasets, and cannot be selected by `npm start`.
