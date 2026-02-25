import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import AudioManager from "../helpers/audioManager";
import logger from "../utils/logger";
import { playStartCue, playStopCue } from "../utils/dictationCues";

export const useAudioRecording = (toast, options = {}) => {
  const { t } = useTranslation();
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isContinuousMode, setIsContinuousMode] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [partialTranscript, setPartialTranscript] = useState("");
  const audioManagerRef = useRef(null);
  const startLockRef = useRef(false);
  const stopLockRef = useRef(false);
  const continuousSegmentCountRef = useRef(0); // Track segments in continuous mode for spacing
  const { onToggle } = options;

  const performStartRecording = useCallback(async () => {
    if (startLockRef.current) return false;
    startLockRef.current = true;
    try {
      if (!audioManagerRef.current) return false;

      const currentState = audioManagerRef.current.getState();
      if (currentState.isRecording || currentState.isProcessing) return false;

      const didStart = audioManagerRef.current.shouldUseStreaming()
        ? await audioManagerRef.current.startStreamingRecording()
        : await audioManagerRef.current.startRecording();

      if (didStart) {
        void playStartCue();
      }

      return didStart;
    } finally {
      startLockRef.current = false;
    }
  }, []);

  const performStopRecording = useCallback(async () => {
    if (stopLockRef.current) return false;
    stopLockRef.current = true;
    try {
      if (!audioManagerRef.current) return false;

      const currentState = audioManagerRef.current.getState();
      if (!currentState.isRecording && !currentState.isStreamingStartInProgress) return false;

      if (currentState.isStreaming || currentState.isStreamingStartInProgress) {
        void playStopCue();
        return await audioManagerRef.current.stopStreamingRecording();
      }

      const didStop = audioManagerRef.current.stopRecording();

      if (didStop) {
        void playStopCue();
      }

      return didStop;
    } finally {
      stopLockRef.current = false;
    }
  }, []);

  useEffect(() => {
    audioManagerRef.current = new AudioManager();

    audioManagerRef.current.setCallbacks({
      onStateChange: ({ isRecording, isProcessing, isStreaming }) => {
        setIsRecording(isRecording);
        setIsProcessing(isProcessing);
        setIsStreaming(isStreaming ?? false);
        setIsContinuousMode(audioManagerRef.current?.isContinuousMode ?? false);
        if (!isStreaming) {
          setPartialTranscript("");
        }
      },
      onError: (error) => {
        // Provide specific titles for cloud error codes
        const title =
          error.code === "AUTH_EXPIRED"
            ? t("hooks.audioRecording.errorTitles.sessionExpired")
            : error.code === "OFFLINE"
              ? t("hooks.audioRecording.errorTitles.offline")
              : error.code === "LIMIT_REACHED"
                ? t("hooks.audioRecording.errorTitles.dailyLimitReached")
                : error.title;

        toast({
          title,
          description: error.description,
          variant: "destructive",
          duration: error.code === "AUTH_EXPIRED" ? 8000 : undefined,
        });
      },
      onPartialTranscript: (text) => {
        setPartialTranscript(text);
      },
      onTranscriptionComplete: async (result) => {
        if (result.success) {
          setTranscript(result.text);

          const isStreaming = result.source?.includes("streaming");
          const isContinuous = audioManagerRef.current?.isContinuousMode ?? false;

          // In continuous mode, prepend space after the first segment
          let textToPaste = result.text;
          if (isContinuous) {
            continuousSegmentCountRef.current += 1;
            if (continuousSegmentCountRef.current > 1) {
              textToPaste = " " + result.text;
            }
          }

          const pasteStart = performance.now();
          await audioManagerRef.current.safePaste(
            textToPaste,
            isStreaming ? { fromStreaming: true } : {}
          );
          logger.info(
            "Paste timing",
            {
              pasteMs: Math.round(performance.now() - pasteStart),
              source: result.source,
              textLength: result.text.length,
            },
            "streaming"
          );

          audioManagerRef.current.saveTranscription(result.text);

          if (result.source === "openai" && localStorage.getItem("useLocalWhisper") === "true") {
            toast({
              title: t("hooks.audioRecording.fallback.title"),
              description: t("hooks.audioRecording.fallback.description"),
              variant: "default",
            });
          }

          // Cloud usage: limit reached after this transcription
          if (result.source === "openwhispr" && result.limitReached) {
            // Notify control panel to show UpgradePrompt dialog
            window.electronAPI?.notifyLimitReached?.({
              wordsUsed: result.wordsUsed,
              limit:
                result.wordsRemaining !== undefined
                  ? result.wordsUsed + result.wordsRemaining
                  : 2000,
            });
          }

          audioManagerRef.current.warmupStreamingConnection();
        }
      },
    });

    audioManagerRef.current.warmupStreamingConnection();

    const handleToggle = async () => {
      if (!audioManagerRef.current) return;
      const currentState = audioManagerRef.current.getState();

      // If continuous mode is active, stop it via the regular toggle too
      if (currentState.isContinuousMode) {
        audioManagerRef.current.stopContinuousRecording();
        return;
      }

      if (!currentState.isRecording && !currentState.isProcessing) {
        await performStartRecording();
      } else if (currentState.isRecording) {
        await performStopRecording();
      }
    };

    const handleStart = async () => {
      await performStartRecording();
    };

    const handleStop = async () => {
      await performStopRecording();
    };

    const disposeToggle = window.electronAPI.onToggleDictation(() => {
      handleToggle();
      onToggle?.();
    });

    const disposeStart = window.electronAPI.onStartDictation?.(() => {
      handleStart();
      onToggle?.();
    });

    const disposeStop = window.electronAPI.onStopDictation?.(() => {
      handleStop();
      onToggle?.();
    });

    const handleToggleContinuous = async () => {
      if (!audioManagerRef.current) return;
      const currentState = audioManagerRef.current.getState();

      if (currentState.isContinuousMode) {
        // Currently in continuous mode - stop it
        void playStopCue();
        // Unregister global shortcuts
        window.electronAPI.unregisterContinuousShortcuts?.();
        audioManagerRef.current.stopContinuousRecording();
      } else if (!currentState.isRecording && !currentState.isProcessing) {
        // Not recording - start continuous mode
        continuousSegmentCountRef.current = 0; // Reset segment counter
        const didStart = await audioManagerRef.current.startContinuousRecording();
        if (didStart) {
          void playStartCue();
          // Register global ESC/ENTER shortcuts to cancel continuous mode
          window.electronAPI.registerContinuousShortcuts?.();
        }
      }
    };

    const disposeToggleContinuous = window.electronAPI.onToggleContinuousDictation?.(() => {
      handleToggleContinuous();
      onToggle?.();
    });

    // Handle global ESC shortcut - cancel continuous mode (no transcription)
    const handleCancelContinuous = () => {
      if (!audioManagerRef.current?.isContinuousMode) return;
      void playStopCue();
      // Unregister global shortcuts
      window.electronAPI.unregisterContinuousShortcuts?.();
      audioManagerRef.current.cancelContinuousRecording();
    };

    // Handle global ENTER shortcut - finish continuous mode (transcribe what was said)
    const handleFinishContinuous = () => {
      if (!audioManagerRef.current?.isContinuousMode) return;
      void playStopCue();
      // Unregister global shortcuts (ENTER already unregistered by main process)
      window.electronAPI.unregisterContinuousShortcuts?.();
      audioManagerRef.current.finishContinuousRecording();
    };

    const disposeCancelContinuous = window.electronAPI.onCancelContinuousDictation?.(handleCancelContinuous);
    const disposeFinishContinuous = window.electronAPI.onFinishContinuousDictation?.(handleFinishContinuous);

    const handleNoAudioDetected = () => {
      toast({
        title: t("hooks.audioRecording.noAudio.title"),
        description: t("hooks.audioRecording.noAudio.description"),
        variant: "default",
      });
    };

    const disposeNoAudio = window.electronAPI.onNoAudioDetected?.(handleNoAudioDetected);

    // Cleanup
    return () => {
      disposeToggle?.();
      disposeStart?.();
      disposeStop?.();
      disposeToggleContinuous?.();
      disposeCancelContinuous?.();
      disposeFinishContinuous?.();
      disposeNoAudio?.();
      // Make sure global shortcuts are unregistered on cleanup
      window.electronAPI.unregisterContinuousShortcuts?.();
      if (audioManagerRef.current) {
        audioManagerRef.current.cleanup();
      }
    };
  }, [toast, onToggle, performStartRecording, performStopRecording, t]);

  const startRecording = async () => {
    return performStartRecording();
  };

  const stopRecording = async () => {
    return performStopRecording();
  };

  const cancelRecording = async () => {
    if (audioManagerRef.current) {
      const state = audioManagerRef.current.getState();
      if (state.isStreaming) {
        return await audioManagerRef.current.stopStreamingRecording();
      }
      return audioManagerRef.current.cancelRecording();
    }
    return false;
  };

  const cancelProcessing = () => {
    if (audioManagerRef.current) {
      return audioManagerRef.current.cancelProcessing();
    }
    return false;
  };

  const toggleListening = async () => {
    if (!isRecording && !isProcessing) {
      await startRecording();
    } else if (isRecording) {
      await stopRecording();
    }
  };

  const warmupStreaming = useCallback((opts) => {
    audioManagerRef.current?.warmupStreamingConnection(opts);
  }, []);

  return {
    isRecording,
    isProcessing,
    isStreaming,
    isContinuousMode,
    transcript,
    partialTranscript,
    startRecording,
    stopRecording,
    cancelRecording,
    cancelProcessing,
    toggleListening,
    warmupStreaming,
  };
};
