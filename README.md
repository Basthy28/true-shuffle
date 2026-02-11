# True Shuffle

A Spicetify extension that replaces Spotify's biased shuffle with a truly random, weighted algorithm.

## Features

- **Weighted Random Shuffle**: Uses a decay-based algorithm that considers recency and artist spacing to produce genuinely random track selection
- **No-Repeat Protection**: Prevents the same track from playing again within the last 100 songs
- **Artist Spacing**: Ensures at least 2 tracks between songs by the same artist
- **Smart Shuffle Compatibility**: Works in hybrid mode — True Shuffle handles every 3rd skip, while native skips preserve Spotify's Smart Shuffle suggestions
- **Navigation History**: Full back/forward navigation support, works across both True Shuffle picks and native picks
- **Smooth Transitions**: Mutes audio during skip transitions for seamless playback
- **Toggle Control**: Topbar button to enable/disable True Shuffle on the fly

## How It Works

True Shuffle activates automatically when Spotify's shuffle button is enabled on a playlist. It operates in a hybrid mode:

| Skip | Handled By | Purpose |
|------|-----------|---------|
| 1st | Spotify Native | Smart Shuffle suggestions may appear |
| 2nd | Spotify Native | Smart Shuffle suggestions may appear |
| 3rd | True Shuffle | Weighted random pick with anti-repeat |

Native picks are also protected against repeats — if Spotify selects a recently played track, it automatically skips again.

## Algorithm

The weighted random algorithm scores each track based on:

1. **Recency decay**: Recently played tracks get exponentially lower weights
2. **Artist penalty**: Tracks by recently heard artists are penalized
3. **Hard exclusion**: Tracks played within the last 100 songs are excluded entirely

## Configuration

The algorithm parameters can be adjusted at the top of `true-shuffle.js`:

```javascript
const CONFIG = {
    HISTORY_SIZE: 500,         // Maximum play history size
    NO_REPEAT_WINDOW: 100,     // Exclude tracks played within last N songs
    MIN_WEIGHT: 0.05,          // Minimum track weight (never fully excluded)
    RECENCY_DECAY_RATE: 0.15,  // How fast recency penalty decays
    ARTIST_PENALTY: 0.15,      // Weight multiplier for same-artist tracks
    ARTIST_SPACING: 2,         // Minimum tracks between same artist
    TRUE_SHUFFLE_EVERY: 3,     // True Shuffle picks every Nth skip
};
```

## Installation

### From Spicetify Marketplace
Search for "True Shuffle" in the Spicetify Marketplace and click Install.

### Manual Installation
1. Copy `true-shuffle.js` to your Spicetify extensions folder:
   - **Windows**: `%appdata%\spicetify\Extensions\`
   - **Linux/macOS**: `~/.config/spicetify/Extensions/`
2. Run:
   ```bash
   spicetify config extensions true-shuffle.js
   spicetify apply
   ```

## Requirements

- [Spicetify](https://spicetify.app/) v2.0.0+
- Spotify Desktop App

## License

MIT
