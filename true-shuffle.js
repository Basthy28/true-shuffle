// True Shuffle — Smart weighted shuffle for Spotify
// Interceptor-Free Architecture (Native Queue Fallback)
// Ensures perfectly stable playback transitions without intercepting DOM clicks.

(async function trueShuffle() {
    // Wait for Spicetify APIs
    while (!Spicetify?.Player?.data || !Spicetify?.Platform?.PlaylistAPI || !Spicetify?.Topbar) {
        await new Promise(r => setTimeout(r, 200));
    }

    const CONFIG = {
        HISTORY_SIZE: 500,
        NO_REPEAT_WINDOW: 100,
        MIN_WEIGHT: 0.05,
        RECENCY_DECAY_RATE: 0.15,
        ARTIST_PENALTY: 0.15,
        ARTIST_SPACING: 2,
        TRUE_SHUFFLE_EVERY: 3,
    };

    let playHistory = [];
    let currentPlaylistUri = null;
    let currentPlaylistTracks = null;
    let isActive = true;
    let skipCounter = 0;

    let isHandlingAction = false;
    let lastKnownPlaylistUri = null;
    let lastPlayedByUsUri = null;

    let origSkipToNextFn = null;
    let isNativePassSkip = false;
    let nativeSkipRetryCount = 0;
    let savedVolume = null;
    let smoothSkipMuted = false;

    // Track progress to mimic natural transitions
    let lastProgress = 0;
    let lastDuration = 0;

    function isSmartShuffleTrack() {
        try {
            const el = document.querySelector('.main-trackInfo-enhanced svg title, .main-trackInfo-xsmallBadges svg title');
            if (el && el.textContent.includes('Smart Shuffle')) {
                return true;
            }
        } catch (e) { }
        return false;
    }

    function isInTrueShuffleMode() {
        try {
            if (!isActive) return false;

            const isSmart = isSmartShuffleTrack();
            const isShuffleOn = Spicetify?.Player?.getShuffle ? Spicetify.Player.getShuffle() : false;

            const contextUri = getContextUri();
            const contextIsGood = (contextUri && contextUri.startsWith("spotify:playlist:")) || !!lastKnownPlaylistUri || isSmart;

            return (isShuffleOn || isSmart) && contextIsGood;
        } catch (err) {
            return false;
        }
    }

    function getContextUri() {
        try {
            return Spicetify.Player.data?.context?.uri || null;
        } catch {
            return null;
        }
    }

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

        const recentUris = new Set(
            history.slice(0, CONFIG.NO_REPEAT_WINDOW).map(h => h.uri)
        );
        let candidates = tracks.filter(t => !recentUris.has(t.uri));

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

    async function loadPlaylistTracks(contextUri) {
        if (!contextUri || !contextUri.startsWith("spotify:playlist:")) return null;

        try {
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout Requesting Tracks")), 1000));
            const contents = await Promise.race([
                Spicetify.Platform.PlaylistAPI.getContents(contextUri),
                timeoutPromise
            ]);

            if (!contents?.items) return null;

            const tracks = [];

            for (const item of contents.items) {
                if (!item.uri || item.type !== "track") continue;
                if (item.isPlayable === false) continue;

                tracks.push({
                    uri: item.uri,
                    artistUri: item.artists?.[0]?.uri || null,
                    name: item.name || "Unknown",
                    artistName: item.artists?.[0]?.name || "Unknown",
                });
            }

            return tracks;
        } catch (err) {
            return null;
        }
    }

    async function ensurePlaylistLoaded() {
        try {
            if (currentPlaylistTracks && currentPlaylistTracks.length > 0) {
                return true;
            }

            const contextUri = getContextUri() || lastKnownPlaylistUri;
            if (!contextUri) {
                return false;
            }

            if (contextUri !== currentPlaylistUri || !currentPlaylistTracks) {
                currentPlaylistUri = contextUri;
                lastKnownPlaylistUri = contextUri;
                const tracks = await loadPlaylistTracks(contextUri);
                if (tracks && tracks.length > 0) {
                    currentPlaylistTracks = tracks;
                }
            }
            return !!(currentPlaylistTracks && currentPlaylistTracks.length > 0);
        } catch (e) {
            return false;
        }
    }

    function recordCurrentTrack() {
        const currentTrack = Spicetify.Player.data?.item;
        if (!currentTrack?.uri) return;

        if (isSmartShuffleTrack()) {
            return;
        }

        const artistUri = currentTrack.metadata?.artist_uri || null;
        playHistory = playHistory.filter(h => h.uri !== currentTrack.uri);
        playHistory.unshift({ uri: currentTrack.uri, artistUri });
        if (playHistory.length > CONFIG.HISTORY_SIZE) {
            playHistory = playHistory.slice(0, CONFIG.HISTORY_SIZE);
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

    // NATIVE CONTEXT PLAY (V2)
    async function playTrackInContext(trackUri) {
        const contextUri = getContextUri() || lastKnownPlaylistUri;
        if (!contextUri) {
            return false;
        }

        try {
            lastPlayedByUsUri = trackUri;

            const playPromise = Spicetify.Platform.PlayerAPI.play(
                { uri: contextUri },
                {},
                { skipTo: { uri: trackUri } }
            );

            // Time out play request to prevent infinite freeze in Spicetify
            await Promise.race([
                playPromise,
                new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 2500))
            ]);

            restoreVolume();
            return true;
        } catch (err) {
            lastPlayedByUsUri = null;
            restoreVolume();
            return false;
        }
    }

    async function handleSkipForward() {
        if (isHandlingAction) return;
        isHandlingAction = true;

        const failsafeId = setTimeout(() => {
            isHandlingAction = false;
        }, 3500);

        try {
            if (!(await ensurePlaylistLoaded())) return;

            recordCurrentTrack();

            skipCounter++;
            if (skipCounter % CONFIG.TRUE_SHUFFLE_EVERY !== 0) {
                isNativePassSkip = true;
                clearTimeout(failsafeId);
                isHandlingAction = false;
                muteForSkip();
                setTimeout(() => origSkipToNextFn(), 50);
                return;
            }

            for (let attempt = 0; attempt < 3; attempt++) {
                const nextTrack = pickNextTrack(currentPlaylistTracks, playHistory);
                if (!nextTrack) return;

                const ok = await playTrackInContext(nextTrack.uri);
                if (ok) {
                    return;
                }

                playHistory.unshift({ uri: nextTrack.uri, artistUri: nextTrack.artistUri });
            }

        } catch (err) {
        } finally {
            clearTimeout(failsafeId);
            setTimeout(() => { isHandlingAction = false; }, 1000);
        }
    }

    // Intercept native skips safely (No DOM Interceptor)
    const origPlayerNext = Spicetify.Player.next.bind(Spicetify.Player);
    Spicetify.Player.next = () => {
        if (isInTrueShuffleMode()) {
            muteForSkip();
            handleSkipForward();
            return;
        }
        origPlayerNext();
    };

    if (Spicetify.Platform?.PlayerAPI?.skipToNext) {
        origSkipToNextFn = Spicetify.Platform.PlayerAPI.skipToNext.bind(Spicetify.Platform.PlayerAPI);
        Spicetify.Platform.PlayerAPI.skipToNext = () => {
            if (isHandlingAction) return;
            if (isInTrueShuffleMode()) {
                muteForSkip();
                handleSkipForward();
                return;
            }
            return origSkipToNextFn();
        };
    }

    setInterval(() => {
        try {
            lastProgress = Spicetify.Player.getProgress() || 0;
            lastDuration = Spicetify.Player.getDuration() || 0;
        } catch { }
    }, 1000);

    let lastContextUri = null;

    Spicetify.Player.addEventListener("songchange", () => {
        const currentUri = Spicetify.Player.data?.item?.uri;
        const contextUri = getContextUri();

        if (isHandlingAction) return;

        if (isNativePassSkip) {
            isNativePassSkip = false;

            if (currentUri) {
                const recentUris = new Set(
                    playHistory.slice(0, CONFIG.NO_REPEAT_WINDOW).map(h => h.uri)
                );

                if (recentUris.has(currentUri)) {
                    if (nativeSkipRetryCount < 3) {
                        nativeSkipRetryCount++;
                        isNativePassSkip = true;
                        muteForSkip();
                        setTimeout(() => origSkipToNextFn(), 50);
                        return;
                    }
                }

                nativeSkipRetryCount = 0;
                recordCurrentTrack();
                restoreVolume();
            }
            return;
        }

        if (currentUri && currentUri === lastPlayedByUsUri) {
            lastPlayedByUsUri = null;
            return;
        }

        if (contextUri !== lastContextUri) {
            lastContextUri = contextUri;
            currentPlaylistUri = null;
            currentPlaylistTracks = null;
            skipCounter = 0;
            playHistory = [];

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

        if (!isInTrueShuffleMode()) return;

        const wasNearEnd = lastDuration > 0 && (lastDuration - lastProgress) < 5000;
        if (wasNearEnd) {
            handleSkipForward();
        }
    });

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
