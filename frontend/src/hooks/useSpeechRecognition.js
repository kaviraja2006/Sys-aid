import { useCallback, useEffect, useRef, useState } from 'react';

// Thin wrapper around the browser's native Web Speech API
// (SpeechRecognition / webkitSpeechRecognition). Free, no backend, no API key.
// Only Chrome/Edge/Opera/Brave implement it — Firefox and Safari are handled
// by the caller checking `isSupported` and simply not rendering the mic UI.
export function useSpeechRecognition({ onTranscript, lang = 'en-US' } = {}) {
  const SpeechRecognitionImpl =
    typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
  const isSupported = Boolean(SpeechRecognitionImpl);

  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState(null);
  const recognitionRef = useRef(null);
  const onTranscriptRef = useRef(onTranscript);
  // Accumulated *final* text for the current listening session, so interim
  // words (still being corrected by the recognizer) never get double-committed.
  const sessionFinalRef = useRef('');
  // True whenever the user *wants* to be listening (set by start()/stop()).
  // Chrome's `continuous: true` mode can silently end a session early (no
  // error, just onend) — often after a short pause — well before the user
  // clicked stop. When that happens and this ref is still true, we restart
  // the recognizer transparently instead of leaving it dead.
  const wantsListeningRef = useRef(false);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  useEffect(() => {
    if (!isSupported) return;
    if (import.meta.env.DEV) console.log('[speech] effect setup — new recognition instance created');

    const recognition = new SpeechRecognitionImpl();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = lang;

    recognition.onresult = (event) => {
      let interimTranscript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          sessionFinalRef.current = `${sessionFinalRef.current} ${result[0].transcript}`.trim();
        } else {
          interimTranscript += result[0].transcript;
        }
      }
      // Fire on every result — interim or final — so the caller can render
      // words into the textarea live, as they're spoken.
      const liveText = `${sessionFinalRef.current} ${interimTranscript}`.trim();
      if (import.meta.env.DEV) console.log('[speech] onresult', { liveText, resultsLength: event.results.length });
      onTranscriptRef.current?.(liveText);
    };

    recognition.onerror = (event) => {
      // 'no-speech' is a harmless, frequent event in continuous mode (fires
      // whenever there's a pause) — let onend's auto-restart handle it rather
      // than surfacing it as an error or giving up.
      if (event.error === 'no-speech') {
        if (import.meta.env.DEV) console.log('[speech] onerror no-speech (ignored, will auto-restart)');
        return;
      }
      const messages = {
        'not-allowed': 'Microphone permission denied.',
        'audio-capture': 'No microphone found.',
        network: 'Network error during speech recognition.',
      };
      setError(messages[event.error] || 'Speech recognition error.');
      wantsListeningRef.current = false;
      setIsListening(false);
      if (import.meta.env.DEV) console.warn('[speech] onerror', event.error);
    };

    recognition.onend = () => {
      if (import.meta.env.DEV) console.log('[speech] onend', { wantsListening: wantsListeningRef.current });
      // Chrome can end a `continuous: true` session early with no error at
      // all (see comment on wantsListeningRef). If the user hasn't asked us
      // to stop, restart transparently so it feels like one continuous session.
      if (wantsListeningRef.current) {
        try {
          recognition.start();
          return;
        } catch (err) {
          if (import.meta.env.DEV) console.warn('[speech] auto-restart failed', err);
        }
      }
      setIsListening(false);
    };

    // Dev-only breadcrumbs to diagnose "listening but nothing types" reports —
    // confirms whether the mic is actually being captured at all.
    // NOTE: console.log (not console.debug) on purpose — Chrome DevTools hides
    // console.debug output under "Verbose" by default, which made earlier
    // versions of this logging invisible unless that filter was toggled on.
    if (import.meta.env.DEV) {
      recognition.onstart = () => console.log('[speech] onstart — recognizer started');
      recognition.onaudiostart = () => console.log('[speech] onaudiostart — mic audio flowing');
      recognition.onsoundstart = () => console.log('[speech] onsoundstart — sound detected');
      recognition.onspeechstart = () => console.log('[speech] onspeechstart — speech detected');
      recognition.onnomatch = () => console.log('[speech] onnomatch — heard audio but could not transcribe it');
    }

    recognitionRef.current = recognition;

    return () => {
      if (import.meta.env.DEV) console.log('[speech] effect cleanup — recognition instance torn down (component unmounted or deps changed)');
      wantsListeningRef.current = false;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.onstart = null;
      recognition.onaudiostart = null;
      recognition.onsoundstart = null;
      recognition.onspeechstart = null;
      recognition.onnomatch = null;
      recognition.stop();
      recognitionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSupported, lang]);

  const start = useCallback(() => {
    if (!recognitionRef.current || isListening) return;
    setError(null);
    sessionFinalRef.current = '';
    wantsListeningRef.current = true;
    try {
      recognitionRef.current.start();
      setIsListening(true);
    } catch {
      // start() throws if already started — ignore, state stays consistent
    }
  }, [isListening]);

  const stop = useCallback(() => {
    if (import.meta.env.DEV) console.log('[speech] stop() called explicitly', new Error().stack);
    wantsListeningRef.current = false;
    if (!recognitionRef.current) return;
    recognitionRef.current.stop();
    setIsListening(false);
  }, []);

  return { isSupported, isListening, start, stop, error };
}
