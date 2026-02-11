// True Shuffle — Smart weighted shuffle for Spotify
// Replaces Spotify's biased shuffle with weighted random + artist spacing
// Works automatically when Spotify's shuffle button is active

(async function trueShuffle() {
    // Wait for Spicetify APIs
    while (!Spicetify?.Player?.data || !Spicetify?.Platform?.PlaylistAPI || !Spicetify?.Topbar) {
        await new Promise(r => setTimeout(r, 200));
    }

    // ===== Configuration =====
    const CONFIG = {
        HISTORY_SIZE: 500,
        NO_REPEAT_WINDOW: 100,   // Hard-exclude tracks played within last N songs
        MIN_WEIGHT: 0.05,
        RECENCY_DECAY_RATE: 0.15,
        ARTIST_PENALTY: 0.15,
        ARTIST_SPACING: 2,
        TRUE_SHUFFLE_EVERY: 3,   // True Shuffle picks every Nth skip; others pass to Spotify native
    };

    // ===== State =====
    let playHistory = [];              // For weighted scoring
    let navigationHistory = [];        // For back/forward navigation
    let navigationIndex = -1;
    let currentPlaylistUri = null;
    let currentPlaylistTracks = null;
    let isActive = true;
    let skipCounter = 0;               // Counts skips for native pass-through
    let isNativePassSkip = false;      // Flag: current skip is a native pass-through

    // Guards against double-firing
    let isHandlingAction = false;      // Synchronous re-entry guard
    let lastPlayedByUsUri = null;      // URI-based songchange guard

    // References to original skip functions (set in monkey-patch section)
    let origSkipToNextFn = null;

    // Smooth skip: mute during transition, restore after
    let savedVolume = null;
    let smoothSkipMuted = false;

    // Progress tracking for end-of-track detection
    let lastProgress = 0;
    let lastDuration = 0;

    // ===== Helpers =====

    function isInTrueShuffleMode() {
        return isActive &&
            Spicetify.Player.getShuffle() &&
            getContextUri()?.startsWith("spotify:playlist:");
    }

    function getContextUri() {
        try {
            return Spicetify.Player.data?.context?.uri || null;
        } catch {
            return null;
        }
    }

    // ===== Weighted Random Algorithm =====

    function calculateWeight(track, history) {
        let weight = 1.0;

        const recencyIndex = history.findIndex(h => h.uri === track.uri);
        if (recencyIndex !== -1) {
            const recencyFactor = 1 - Math.exp(-CONFIG.RECENCY_DECAY_RATE * recencyIndex);
            weight *= Math.max(CONFIG.MIN_WEIGHT, recencyFactor);
        }

        const recentArtists = history.slice(0, CONFIG.ARTIST_SPACING).map(h => h.artistUri);
        if (track.artistUri && recentArtists.includes(track.artistUri)) {
            weight *= CONFIG.ARTIST_PENALTY;
        }

        return Math.max(CONFIG.MIN_WEIGHT, weight);
    }

    function pickNextTrack(tracks, history) {
        if (!tracks || tracks.length === 0) return null;
        if (tracks.length === 1) return tracks[0];

        // Hard-exclude tracks played within NO_REPEAT_WINDOW
        const recentUris = new Set(
            history.slice(0, CONFIG.NO_REPEAT_WINDOW).map(h => h.uri)
        );
        let candidates = tracks.filter(t => !recentUris.has(t.uri));

        // Fallback: if all tracks are excluded, reset
        if (candidates.length === 0) {
            candidates = tracks;
        }

        const weighted = candidates.map(track => ({
            track,
            weight: calculateWeight(track, history)
        }));

        const totalWeight = weighted.reduce((sum, w) => sum + w.weight, 0);
        let random = Math.random() * totalWeight;

        for (const { track, weight } of weighted) {
            random -= weight;
            if (random <= 0) return track;
        }

        return weighted[weighted.length - 1].track;
    }

    // ===== Playlist Loading =====

    async function loadPlaylistTracks(contextUri) {
        if (!contextUri || !contextUri.startsWith("spotify:playlist:")) return null;

        try {
            const contents = await Spicetify.Platform.PlaylistAPI.getContents(contextUri);
            if (!contents?.items) return null;

            const tracks = [];

            for (const item of contents.items) {
                if (!item.uri || item.type !== "track") continue;

                // Skip unplayable tracks to prevent player crashes
                if (item.isPlayable === false) {
                    continue;
                }

                tracks.push({
                    uri: item.uri,
                    artistUri: item.artists?.[0]?.uri || null,
                    name: item.name || "Unknown",
                    artistName: item.artists?.[0]?.name || "Unknown",
                });
            }

            return tracks;
        } catch (err) {
            console.error("[true-shuffle] Error loading playlist:", err);
            return null;
        }
    }

    async function ensurePlaylistLoaded() {
        const contextUri = getContextUri();
        if (!contextUri) return false;

        if (contextUri !== currentPlaylistUri || !currentPlaylistTracks) {
            currentPlaylistUri = contextUri;
            currentPlaylistTracks = await loadPlaylistTracks(contextUri);
        }
        return !!(currentPlaylistTracks && currentPlaylistTracks.length > 0);
    }

    // ===== History Management =====

    function recordCurrentTrack() {
        const currentTrack = Spicetify.Player.data?.item;
        if (!currentTrack?.uri) return;

        const artistUri = currentTrack.metadata?.artist_uri || null;
        playHistory = playHistory.filter(h => h.uri !== currentTrack.uri);
        playHistory.unshift({ uri: currentTrack.uri, artistUri });
        if (playHistory.length > CONFIG.HISTORY_SIZE) {
            playHistory = playHistory.slice(0, CONFIG.HISTORY_SIZE);
        }
    }

    function pushToNavigation(uri) {
        if (!uri) return;
        // If we navigated back and now play a new track, truncate forward history
        if (navigationIndex < navigationHistory.length - 1) {
            navigationHistory = navigationHistory.slice(0, navigationIndex + 1);
        }
        navigationHistory.push(uri);
        navigationIndex = navigationHistory.length - 1;

        if (navigationHistory.length > CONFIG.HISTORY_SIZE) {
            navigationHistory = navigationHistory.slice(navigationHistory.length - CONFIG.HISTORY_SIZE);
            navigationIndex = navigationHistory.length - 1;
        }
    }

    // ===== Play a specific track in the playlist context =====

    async function playTrackInContext(trackUri) {
        const contextUri = getContextUri();
        if (!contextUri) return false;

        try {
            lastPlayedByUsUri = trackUri;
            await Spicetify.Platform.PlayerAPI.play(
                { uri: contextUri },
                {},
                { skipTo: { uri: trackUri } }
            );
            // Restore volume after track starts
            restoreVolume();
            return true;
        } catch (err) {
            lastPlayedByUsUri = null;
            restoreVolume();
            return false;
        }
    }

    function muteForSkip() {
        if (!smoothSkipMuted) {
            savedVolume = Spicetify.Player.getVolume();
            smoothSkipMuted = true;
        }
        Spicetify.Player.setVolume(0);
    }

    function restoreVolume() {
        if (smoothSkipMuted && savedVolume !== null) {
            Spicetify.Player.setVolume(savedVolume);
            smoothSkipMuted = false;
            savedVolume = null;
        }
    }

    // ===== Core Actions =====

    async function handleSkipForward() {
        // Synchronous re-entry guard — prevents double-skip
        if (isHandlingAction) return;
        isHandlingAction = true;

        try {
            if (!(await ensurePlaylistLoaded())) return;

            recordCurrentTrack();

            // If we're in the middle of nav history, go forward
            if (navigationIndex < navigationHistory.length - 1) {
                navigationIndex++;
                const nextUri = navigationHistory[navigationIndex];
                const ok = await playTrackInContext(nextUri);
                if (!ok) {
                    navigationIndex--;
                } else {
                    return;
                }
            }

            // Native pass-through: let Spotify handle some skips
            // Smart Shuffle suggestions may appear on these native skips
            skipCounter++;
            if (skipCounter % CONFIG.TRUE_SHUFFLE_EVERY !== 0) {
                isNativePassSkip = true;
                isHandlingAction = false; // Release guard BEFORE native skip
                muteForSkip();
                setTimeout(() => origSkipToNextFn(), 50);
                return;
            }

            // True Shuffle pick — weighted random
            for (let attempt = 0; attempt < 3; attempt++) {
                const nextTrack = pickNextTrack(currentPlaylistTracks, playHistory);
                if (!nextTrack) return;

                const ok = await playTrackInContext(nextTrack.uri);
                if (ok) {
                    pushToNavigation(nextTrack.uri);
                    return;
                }

                // Track failed to play — add to history so we skip it next time
                playHistory.unshift({ uri: nextTrack.uri, artistUri: nextTrack.artistUri });
            }

        } catch (err) {
        } finally {
            // Keep the guard up long enough for songchange events to settle
            setTimeout(() => { isHandlingAction = false; }, 1500);
        }
    }

    async function handleSkipBack() {
        if (isHandlingAction) return;
        isHandlingAction = true;

        try {
            if (navigationIndex > 0) {
                navigationIndex--;
                const prevUri = navigationHistory[navigationIndex];
                await playTrackInContext(prevUri);
            } else {
                Spicetify.Player.seek(0);
            }
        } catch (err) {
        } finally {
            setTimeout(() => { isHandlingAction = false; }, 1500);
        }
    }

    // ===== Intercept skip at BOTH API levels =====
    // Spotify UI buttons may call PlayerAPI directly, bypassing Player.next()

    // Level 1: Spicetify.Player.next / back
    const origPlayerNext = Spicetify.Player.next.bind(Spicetify.Player);
    Spicetify.Player.next = () => {
        if (isInTrueShuffleMode()) {
            muteForSkip();
            handleSkipForward();
            return;
        }
        origPlayerNext();
    };

    const origPlayerBack = Spicetify.Player.back.bind(Spicetify.Player);
    Spicetify.Player.back = () => {
        if (isInTrueShuffleMode()) {
            handleSkipBack();
            return;
        }
        origPlayerBack();
    };

    // Level 2: Spicetify.Platform.PlayerAPI.skipToNext / skipToPrevious
    if (Spicetify.Platform?.PlayerAPI?.skipToNext) {
        origSkipToNextFn = Spicetify.Platform.PlayerAPI.skipToNext.bind(Spicetify.Platform.PlayerAPI);
        Spicetify.Platform.PlayerAPI.skipToNext = () => {
            // Block during our own handling to prevent cascade errors
            if (isHandlingAction) return;
            if (isInTrueShuffleMode()) {
                muteForSkip();
                handleSkipForward();
                return;
            }
            return origSkipToNextFn();
        };
    }

    if (Spicetify.Platform?.PlayerAPI?.skipToPrevious) {
        const origSkipToPrev = Spicetify.Platform.PlayerAPI.skipToPrevious.bind(Spicetify.Platform.PlayerAPI);
        Spicetify.Platform.PlayerAPI.skipToPrevious = () => {
            // Block during our own handling to prevent cascade errors
            if (isHandlingAction) return;
            if (isInTrueShuffleMode()) {
                handleSkipBack();
                return;
            }
            return origSkipToPrev();
        };
    }

    // ===== Track progress for end-of-track detection =====
    setInterval(() => {
        try {
            lastProgress = Spicetify.Player.getProgress() || 0;
            lastDuration = Spicetify.Player.getDuration() || 0;
        } catch { }
    }, 1000);

    // ===== Songchange listener =====
    // Now ONLY used for: context changes + natural end-of-track auto-advance
    // Skip actions are fully handled by the monkey-patches above

    let lastContextUri = null;

    Spicetify.Player.addEventListener("songchange", () => {
        const currentUri = Spicetify.Player.data?.item?.uri;
        const contextUri = getContextUri();

        // Guard: if we're currently handling an action, ignore
        if (isHandlingAction) return;

        // Native pass-through: record the track that Spotify picked
        if (isNativePassSkip) {
            isNativePassSkip = false;
            if (currentUri) {
                const trackName = Spicetify.Player.data?.item?.metadata?.title || "Unknown";
                const artistName = Spicetify.Player.data?.item?.metadata?.artist_name || "Unknown";

                // Check if this track was recently played (anti-repeat for native skips)
                const recentUris = new Set(
                    playHistory.slice(0, CONFIG.NO_REPEAT_WINDOW).map(h => h.uri)
                );
                if (recentUris.has(currentUri)) {
                    isNativePassSkip = true;
                    muteForSkip();
                    setTimeout(() => origSkipToNextFn(), 50);
                    return;
                }


                pushToNavigation(currentUri);
                recordCurrentTrack();
                restoreVolume(); // Unmute after native pick is accepted
            }
            return;
        }

        // Guard: if this song was played by us, ignore
        if (currentUri && currentUri === lastPlayedByUsUri) {
            lastPlayedByUsUri = null;
            return;
        }

        // Context change — user switched to a new playlist
        if (contextUri !== lastContextUri) {
            lastContextUri = contextUri;
            currentPlaylistUri = null;
            currentPlaylistTracks = null;
            skipCounter = 0;
            playHistory = [];
            navigationHistory = [];
            navigationIndex = -1;

            // Seed navigation with the first track
            if (currentUri) {
                pushToNavigation(currentUri);
            }

            // Pre-load playlist tracks
            if (contextUri?.startsWith("spotify:playlist:")) {
                loadPlaylistTracks(contextUri).then(tracks => {
                    if (tracks) {
                        currentPlaylistUri = contextUri;
                        currentPlaylistTracks = tracks;
                    }
                });
            }
            return;
        }

        // Auto-advance: only if the previous song was near its end
        // This means the song ended naturally (not a user skip)
        if (!isInTrueShuffleMode()) return;

        const wasNearEnd = lastDuration > 0 && (lastDuration - lastProgress) < 5000;
        if (wasNearEnd) {
            handleSkipForward();
        }
        // If not near end: this was a skip we didn't catch. Let Spotify's pick play
        // (no double-skip — we simply don't override it)
    });

    // ===== Topbar Button =====

    const ICON_ACTIVE = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M13.151.922a.75.75 0 10-1.06 1.06L13.109 3H11.16a3.75 3.75 0 00-2.873 1.34l-6.173 7.356A2.25 2.25 0 01.39 12.5H0V14h.391a3.75 3.75 0 002.873-1.34l6.173-7.356a2.25 2.25 0 011.724-.804h1.947l-1.017 1.018a.75.75 0 001.06 1.06L15.98 3.75 13.15.922zM.391 3.5H0V2h.391c1.109 0 2.16.49 2.873 1.34L4.89 5.277l-.979 1.167-1.796-2.14A2.25 2.25 0 00.39 3.5z"/><path d="M7.5 10.723l.98-1.167 1.796 2.14a2.25 2.25 0 001.724.804h1.947l-1.017-1.018a.75.75 0 111.06-1.06l2.829 2.828-2.829 2.828a.75.75 0 11-1.06-1.06L13.109 13H11.16a3.75 3.75 0 01-2.873-1.34L7.5 10.723z"/></svg>`;
    const ICON_INACTIVE = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" opacity="0.5"><path d="M13.151.922a.75.75 0 10-1.06 1.06L13.109 3H11.16a3.75 3.75 0 00-2.873 1.34l-6.173 7.356A2.25 2.25 0 01.39 12.5H0V14h.391a3.75 3.75 0 002.873-1.34l6.173-7.356a2.25 2.25 0 011.724-.804h1.947l-1.017 1.018a.75.75 0 001.06 1.06L15.98 3.75 13.15.922zM.391 3.5H0V2h.391c1.109 0 2.16.49 2.873 1.34L4.89 5.277l-.979 1.167-1.796-2.14A2.25 2.25 0 00.39 3.5z"/><path d="M7.5 10.723l.98-1.167 1.796 2.14a2.25 2.25 0 001.724.804h1.947l-1.017-1.018a.75.75 0 111.06-1.06l2.829 2.828-2.829 2.828a.75.75 0 11-1.06-1.06L13.109 13H11.16a3.75 3.75 0 01-2.873-1.34L7.5 10.723z"/></svg>`;

    function updateButtonState(button) {
        button.icon = isActive ? ICON_ACTIVE : ICON_INACTIVE;
        button.label = isActive ? "True Shuffle: ON" : "True Shuffle: OFF";
    }

    const topbarButton = new Spicetify.Topbar.Button(
        "True Shuffle: ON",
        ICON_ACTIVE,
        () => {
            isActive = !isActive;
            updateButtonState(topbarButton);
            Spicetify.showNotification(isActive ? "True Shuffle enabled" : "True Shuffle disabled");
        }
    );


})();
