'use client';

import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight, Check, Compass, Flag, ListChecks, MessageSquare, Mic,
  RotateCcw, Send, Sparkles, Square, Volume2, VolumeX, X, Zap,
} from 'lucide-react';
import {
  courseStepCount, emptyCourseProgress, gradeCourseInteraction, isCourseAnswerReady,
  revealCourseAnswer, splitStepTeaching, stepXp, summarizeCourseAnswer,
  type Capabilities, type CourseAnswer, type CourseHistoryEntry, type CourseProgress,
  type CourseScript, type CourseStep, type CourseTurnIntent, type CourseVisual, type Session,
} from '@milli/contracts';
import { api, downloadBlob, errorText } from '@/lib/api';
import { unlockLessonAudio, useLessonAudio } from '@/lib/lesson-audio';
import { useInlineMic } from '@/hooks/useInlineMic';
import { CourseVisualRenderer } from './CourseVisuals';
import { CourseInteractionWidget, initialCourseAnswer } from './CourseInteractions';
import { FormattedStepText, MilliMascot, type MascotMood } from './MilliMascot';

function appendHistory(
  existing: CourseHistoryEntry[] | undefined,
  entries: CourseHistoryEntry[],
): CourseHistoryEntry[] {
  return [...(existing ?? []), ...entries].slice(-20);
}

export function LessonPlayer({ id }: { id: string }) {
  const [session, setSession] = useState<Session>();
  const [script, setScript] = useState<CourseScript>();
  const [progress, setProgress] = useState<CourseProgress>(emptyCourseProgress);
  const progressWrites = useMemo(() => ({ revision: 0, pending: Promise.resolve() }), [id]);
  const [capabilities, setCapabilities] = useState<Capabilities>({ tutor: false, speech: false, voice: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Progressive background chapter preparation
  const [preparingChapterIdx, setPreparingChapterIdx] = useState<number | null>(null);
  const preparingLockRef = useRef(false);
  const [syllabusOpen, setSyllabusOpen] = useState(false);

  // Two-stage pedagogical loop per step: 'teach' (concept first + spoken) -> 'practice' (question + interactive check)
  const [stage, setStage] = useState<'teach' | 'practice'>('teach');
  const [answer, setAnswer] = useState<CourseAnswer | undefined>(undefined);
  const [checkStatus, setCheckStatus] = useState<'idle' | 'correct' | 'incorrect'>('idle');
  const [wrongIds, setWrongIds] = useState<string[]>([]);
  const [attempts, setAttempts] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [paramOverrides, setParamOverrides] = useState<Record<string, number>>({});
  const [showDemo, setShowDemo] = useState(false);

  // Agentic companion state
  const [bubbleText, setBubbleText] = useState<string>('');
  const [bubbleTone, setBubbleTone] = useState<'prompt' | 'yep' | 'try' | 'explain'>('prompt');
  const [turnIntent, setTurnIntent] = useState<CourseTurnIntent | null>(null);
  const [bridgeText, setBridgeText] = useState<string>('');
  const [clarifyVisual, setClarifyVisual] = useState<CourseVisual | undefined>(undefined);
  const [insertedStepId, setInsertedStepId] = useState<string | null>(null);
  const [quickReplies, setQuickReplies] = useState<string[]>([]);
  const [splitExplain, setSplitExplain] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const isPanelOpen = splitExplain || chatOpen;
  const [chatInput, setChatInput] = useState('');
  const [showAnswerInput, setShowAnswerInput] = useState(false);
  const [helpBusy, setHelpBusy] = useState(false);
  const activeTurnRef = useRef<AbortController | null>(null);
  const [highlightIds, setHighlightIds] = useState<string[]>([]);
  const [flaggedSteps, setFlaggedSteps] = useState<Record<string, boolean>>({});
  const [speechAlert, setSpeechAlert] = useState<string>('');
  const dismissedSpeechAlertRef = useRef(false);

  const chatInputRef = useRef<HTMLInputElement | null>(null);
  const questionSectionRef = useRef<HTMLDivElement | null>(null);
  const userInteractingRef = useRef(false);
  const graphChangedRef = useRef(false);

  const cancelTutorTurn = useCallback(() => {
    activeTurnRef.current?.abort();
    activeTurnRef.current = null;
    setHelpBusy(false);
  }, []);
  useEffect(() => () => activeTurnRef.current?.abort(), [id]);

  const switchToChatWithNotice = useCallback((message: string, forceShow = true) => {
    if (forceShow || !dismissedSpeechAlertRef.current) {
      setSpeechAlert(message);
    }
    setChatOpen(true);
    if (forceShow) {
      setTimeout(() => chatInputRef.current?.focus(), 30);
    }
  }, []);

  const audio = useLessonAudio({
    onSpeechUnreachable: (msg, manual) => {
      switchToChatWithNotice(msg, manual);
    },
  });
  const sessionMode: 'sample' | 'live' = session?.mode === 'live' ? 'live' : 'sample';

  useEffect(() => {
    if (audio.speaking) setSpeechAlert('');
  }, [audio.speaking]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [sess, courseData, health] = await Promise.all([
        api.session(id),
        api.course(id),
        api.health().catch(() => ({ tutor: false, speech: false, voice: false })),
      ]);
      setSession(sess);
      setScript(courseData.script);
      setProgress(courseData.progress);
      progressWrites.revision = courseData.revision;
      setCapabilities(health);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [id, progressWrites]);

  useEffect(() => { void load(); }, [load]);

  // Background syllabus chapter generator: prepares pending chapters while learner studies Chapter 1!
  useEffect(() => {
    if (!script || progress.completedAt || preparingLockRef.current) return;
    const nextPending = script.chapters.findIndex(ch => ch.status === 'pending' || ch.steps.length === 0);
    if (nextPending < 0) return;

    let cancelled = false;
    const controller = new AbortController();
    preparingLockRef.current = true;
    setPreparingChapterIdx(nextPending);

    void api.prepareCourseChapter(id, nextPending, controller.signal)
      .then(res => {
        if (cancelled) return;
        setScript(prev => {
          if (!prev) return res.script;
          // Preserve any adaptive remedial steps spliced into active chapters while merging newly prepared chapters
          return {
            ...prev,
            chapters: prev.chapters.map((ch, idx) => {
              const incoming = res.script.chapters[idx];
              if (!incoming) return ch;
              if ((ch.status === 'pending' || ch.steps.length === 0) && incoming.status === 'ready') {
                return incoming;
              }
              return ch;
            }),
          };
        });
      })
      .catch(() => {
        // Will retry cleanly if learner reaches the chapter
      })
      .finally(() => {
        preparingLockRef.current = false;
        if (!cancelled) setPreparingChapterIdx(null);
      });

    return () => {
      cancelled = true;
      controller.abort();
      preparingLockRef.current = false;
    };
  }, [id, script, progress.completedAt]);

  const chapters = script?.chapters ?? [];
  const chapterIndex = Math.min(progress.chapter, Math.max(0, chapters.length - 1));
  const currentChapter = chapters[chapterIndex];
  const steps = currentChapter?.steps ?? [];
  const stepIndex = Math.min(progress.step, Math.max(0, steps.length - 1));
  const currentStep: CourseStep | undefined = steps[stepIndex];
  const hasQuestion = Boolean(currentStep?.interaction || currentStep?.spokenQuestion);
  const sliderBinding = currentStep?.interaction?.type === 'slider' ? currentStep.interaction.bindParam : undefined;
  const plotControl = currentStep?.visual?.kind === 'plot'
    ? currentStep.visual.params.find(param => param.name === sliderBinding)?.name
    : undefined;
  const stepTeaching = useMemo(() => (currentStep ? splitStepTeaching(currentStep) : null), [currentStep]);

  const advanceToPractice = useCallback((overrideSpeech?: string) => {
    if (!currentStep || !stepTeaching) return;
    setStage('practice');
    setShowDemo(false);
    setBubbleText('');
    setBubbleTone('prompt');
    setHighlightIds([]);
    setTimeout(() => {
      questionSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 60);
    if (overrideSpeech) {
      void audio.speak({
        sessionId: id,
        text: overrideSpeech,
        mode: sessionMode,
        speechConfigured: capabilities.speech,
      });
    }
  }, [audio, capabilities.speech, currentStep, id, sessionMode, stepTeaching]);

  // Unified teacher delivery in ONE call (concept + challenge together, zero secondary roundtrip)
  useEffect(() => {
    if (!currentStep || !stepTeaching) return;
    userInteractingRef.current = false;
    const saved = progress.results[currentStep.id];

    setWrongIds([]);
    setQuickReplies([]);
    setSplitExplain(false);
    setTurnIntent(null);
    setBridgeText('');
    setClarifyVisual(undefined);
    setInsertedStepId(null);
    setParamOverrides({});
    setShowDemo(false);
    setShowAnswerInput(false);
    setChatInput('');
    graphChangedRef.current = false;

    if (saved?.correct && hasQuestion) {
      setStage('practice');
      setAnswer(currentStep.interaction ? revealCourseAnswer(currentStep.interaction) : undefined);
      setCheckStatus('correct');
      setAttempts(saved.attempts);
      setRevealed(saved.revealed);
      setHighlightIds([]);
      setBubbleText('Yep.');
      setBubbleTone('yep');
      return;
    }

    setAnswer(initialCourseAnswer(currentStep.interaction));
    setCheckStatus('idle');
    setAttempts(0);
    setRevealed(false);

    setStage('teach');
    setHighlightIds(stepTeaching.highlightIds);
    setBubbleText('');
    setBubbleTone('prompt');

    void audio.speak({
      sessionId: id,
      stepId: currentStep.id,
      part: 'step',
      text: stepTeaching.combinedSpeech.slice(0, 900),
      mode: sessionMode,
      speechConfigured: capabilities.speech,
      onStart: () => setShowDemo(Boolean(currentStep.demonstration)),
      onComplete: () => {
        if (!userInteractingRef.current) {
          advanceToPractice();
        }
      },
    });

  }, [currentStep?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const persistProgress = useCallback((next: CourseProgress) => {
    setProgress(next);
    // Each write uses the revision returned by the previous one. An older
    // response must never replace newer progress already shown in the player.
    progressWrites.pending = progressWrites.pending.then(async () => {
      const saved = await api.saveCourseProgress(id, next, progressWrites.revision);
      progressWrites.revision = saved.revision;
    }).catch(() => {
      // Keep optimistic progress locally if storage is temporarily unavailable.
    });
    return progressWrites.pending;
  }, [id, progressWrites]);

  // Core Adaptive Agentic Turn runner (handles spoken/typed learner inputs, side-questions, hints, remedial insertions)
  const askCompanion = useCallback(async (rawText: string, mode: 'typed' | 'spoken' = 'typed', answering = false) => {
    const clean = rawText.trim();
    if (!clean || !currentStep || activeTurnRef.current) return;

    unlockLessonAudio();
    audio.stop();
    userInteractingRef.current = true;
    const low = clean.toLowerCase();

    // Instant UI actions for deterministic chips
    if ((low === 'back to question' || low === 'got it') && stage === 'practice') {
      setSplitExplain(false);
      setBridgeText('');
      setClarifyVisual(undefined);
      setQuickReplies([]);
      userInteractingRef.current = false;
      return;
    }
    if (low === 'ask me the question' || low === 'ready for question') {
      setSplitExplain(false);
      setBridgeText('');
      setClarifyVisual(undefined);
      userInteractingRef.current = false;
      advanceToPractice(stepTeaching?.questionSpeech);
      return;
    }
    if (low === 'continue' && (checkStatus === 'correct' || !hasQuestion)) {
      void handleContinue();
      return;
    }
    if (low === 'try simpler step' && insertedStepId && currentChapter) {
      const targetIdx = currentChapter.steps.findIndex(s => s.id === insertedStepId);
      if (targetIdx >= 0) {
        setSplitExplain(false);
        await persistProgress({ ...progress, chapter: chapterIndex, step: targetIdx, stage: 'teach' });
        return;
      }
    }
    if (low === 'show answer' && hasQuestion) {
      setRevealed(true);
      if (currentStep.interaction) setAnswer(revealCourseAnswer(currentStep.interaction));
      setCheckStatus('correct');
      setSplitExplain(true);
      setTurnIntent('clarify');
      setBubbleTone('explain');
      setBridgeText('');
      setBubbleText(`${currentStep.explanation}\n\nDoes that make sense?`);
      setQuickReplies(['Yes', 'Explain simpler']);
      const nextProg: CourseProgress = {
        ...progress,
        results: { ...progress.results, [currentStep.id]: { correct: true, attempts: Math.max(1, attempts), revealed: true, xp: 0 } },
      };
      void persistProgress(nextProg);
      void audio.speak({ sessionId: id, stepId: currentStep.id, part: 'explanation', text: currentStep.explanation, mode: sessionMode, speechConfigured: capabilities.speech });
      return;
    }
    if (low === 'yes' && checkStatus === 'correct') {
      setSplitExplain(false);
      setBubbleTone('yep');
      setBubbleText('Awesome — click Continue whenever you’re ready!');
      setQuickReplies([]);
      return;
    }

    const isSimplerRequest = low === 'explain simpler' || low === 'try simpler step' || low === 'no';
    const answerSummary = currentStep.interaction ? summarizeCourseAnswer(currentStep.interaction, answer) : undefined;

    const turn = new AbortController();
    activeTurnRef.current = turn;
    setHelpBusy(true);
    setChatInput('');
    setSplitExplain(!answering);
    setBubbleTone('explain');

    try {
      const { reply, script: updatedScript } = await api.courseTurn(id, {
        stepId: currentStep.id,
        event: isSimplerRequest ? 'simpler' : 'learner-message',
        mode,
        learnerText: clean,
        answer,
        answerSummary,
        attempts,
        stage: checkStatus === 'correct' ? 'checked' : stage,
      }, turn.signal);
      if (turn.signal.aborted) return;

      setScript(updatedScript);
      setTurnIntent(reply.intent);
      setBubbleText(sessionMode === 'live' && reply.source === 'prepared' ? `Prepared feedback: ${reply.displayText}` : reply.displayText);
      if (answering && reply.intent === 'side-question') setSplitExplain(true);
      setBridgeText(reply.bridgeText ?? '');
      setClarifyVisual(reply.clarifyVisual);
      setQuickReplies(reply.replies);
      if (reply.highlight.length) setHighlightIds(reply.highlight);
      if (reply.insertedStep) setInsertedStepId(reply.insertedStep.id);

      const newHistory = appendHistory(progress.history, [
        { role: 'learner', text: clean.slice(0, 800), stepId: currentStep.id, intent: mode },
        { role: 'tutor', text: reply.spokenText, stepId: currentStep.id, intent: reply.intent },
      ]);

      // If learner answered the active question accurately by voice or text!
      if (reply.markStepSolved && reply.intent === 'spoken-answer' && hasQuestion && checkStatus !== 'correct') {
        setStage('practice');
        setShowDemo(false);
        const nextAttempts = Math.max(1, attempts + 1);
        setAttempts(nextAttempts);
        if (currentStep.interaction) setAnswer(revealCourseAnswer(currentStep.interaction));
        setCheckStatus('correct');
        setBubbleTone('yep');
        setWrongIds([]);
        const already = progress.results[currentStep.id];
        const earned = already ? 0 : stepXp(nextAttempts, revealed);
        void persistProgress({
          ...progress,
          stage: 'practice',
          xp: progress.xp + earned,
          results: {
            ...progress.results,
            [currentStep.id]: already ?? { correct: true, attempts: nextAttempts, revealed, xp: earned },
          },
          history: newHistory,
        });
      } else {
        if (reply.intent === 'spoken-answer' && stage === 'practice' && checkStatus !== 'correct') {
          setAttempts(attempts + 1);
          setCheckStatus('incorrect');
          setBubbleTone('try');
        }
        void persistProgress({ ...progress, history: newHistory });
      }

      // If learner asked to move to the practice question from 'teach' stage
      if (reply.advanceToPractice && stage === 'teach') {
        setSplitExplain(false);
        userInteractingRef.current = false;
        advanceToPractice(reply.spokenText);
        return;
      }

      // If user explicitly clicked "Try simpler step" and a remedial step was just spliced in, jump straight to it
      if (low === 'try simpler step' && reply.insertedStep) {
        const ch = updatedScript.chapters[chapterIndex];
        const newIdx = ch?.steps.findIndex(s => s.id === reply.insertedStep!.id) ?? -1;
        if (newIdx >= 0) {
          setSplitExplain(false);
          await persistProgress({ ...progress, chapter: chapterIndex, step: newIdx, stage: 'teach', history: newHistory });
          return;
        }
      }

      void audio.speak({
        sessionId: id,
        text: reply.spokenText,
        mode: sessionMode,
        speechConfigured: capabilities.speech,
      });
    } catch (e) {
      if (turn.signal.aborted) return;
      setTurnIntent('clarify');
      setBubbleText(currentStep.hint || currentStep.explanation || errorText(e));
      setQuickReplies(['Back to question']);
    } finally {
      if (activeTurnRef.current === turn) cancelTutorTurn();
    }
  }, [
    advanceToPractice, answer, attempts, audio, capabilities.speech, chapterIndex,
    cancelTutorTurn, checkStatus, currentChapter, currentStep, hasQuestion, id, insertedStepId,
    persistProgress, progress, revealed, sessionMode, stage, stepTeaching,
  ]);

  const mic = useInlineMic({
    sessionId: id,
    onStartListening: () => {
      cancelTutorTurn();
      unlockLessonAudio();
      audio.stop();
      userInteractingRef.current = true;
    },
    onTranscript: text => {
      setSpeechAlert('');
      void askCompanion(text, 'spoken', stage === 'practice' && checkStatus !== 'correct');
    },
    onError: msg => {
      dismissedSpeechAlertRef.current = false;
      switchToChatWithNotice(msg, true);
    },
  });

  const handleTriggerMic = useCallback(() => {
    unlockLessonAudio();
    audio.stop();
    userInteractingRef.current = true;
    if (mic.state === 'listening') {
      mic.stopAndSend();
      return;
    }
    if (mic.state !== 'idle') return;
    if (sessionMode === 'sample') {
      dismissedSpeechAlertRef.current = false;
      switchToChatWithNotice('Voice is disabled in offline sample mode. Continue with chat below.', true);
      return;
    }
    if (!capabilities.speech) {
      dismissedSpeechAlertRef.current = false;
      switchToChatWithNotice('AssemblyAI speech recognition is unreachable right now. Continue with chat.', true);
      return;
    }
    void mic.start();
  }, [audio, capabilities.speech, mic, sessionMode, switchToChatWithNotice]);

  // Keyboard shortcuts: `/` opens typed input, `v` toggles inline voice mic
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === '/') {
        e.preventDefault();
        audio.stop();
        userInteractingRef.current = true;
        setChatOpen(true);
        setTimeout(() => chatInputRef.current?.focus(), 20);
      } else if (e.key.toLowerCase() === 'v' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        handleTriggerMic();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [audio, handleTriggerMic]);

  const totalSteps = useMemo(() => (script ? courseStepCount(script) : 1), [script]);
  const completedSteps = useMemo(() => Object.values(progress.results).filter(r => r.correct).length, [progress.results]);
  const progressPct = Math.min(100, Math.round(((completedSteps + (checkStatus === 'correct' ? 0.2 : stage === 'practice' ? 0.1 : 0.04)) / Math.max(1, totalSteps)) * 100));

  async function handleCheck(observed = false) {
    if (!currentStep || activeTurnRef.current) return;
    unlockLessonAudio();
    audio.stop();
    if (!currentStep.interaction) {
      await handleContinue();
      return;
    }
    if (!answer || !isCourseAnswerReady(currentStep.interaction, answer)) return;

    const nextAttempts = attempts + 1;
    setAttempts(nextAttempts);
    const outcome = gradeCourseInteraction(currentStep.interaction, answer);
    const summary = summarizeCourseAnswer(currentStep.interaction, answer);

    if (outcome.correct) {
      setCheckStatus('correct');
      setWrongIds([]);
      setSplitExplain(false);
      setBridgeText('');
      setClarifyVisual(undefined);
      const observation = observed && answer.type === 'slider' && currentStep.interaction.type === 'slider'
        ? `You found it. At ${answer.value}${currentStep.interaction.unit ?? ''}, the graph hits the target.`
        : '';
      setBubbleText(observation || 'Yep.');
      setBubbleTone('yep');
      setQuickReplies([]);

      const already = progress.results[currentStep.id];
      const earned = already ? 0 : stepXp(nextAttempts, revealed);
      const nextProg: CourseProgress = {
        ...progress,
        stage: 'practice',
        xp: progress.xp + earned,
        results: {
          ...progress.results,
          [currentStep.id]: already ?? { correct: true, attempts: nextAttempts, revealed, xp: earned },
        },
        history: appendHistory(progress.history, [
          { role: 'learner', text: `Solved ${currentStep.id}: ${summary}`.slice(0, 280), stepId: currentStep.id, intent: 'check-correct' },
        ]),
      };
      void persistProgress(nextProg);

      // The validated step already contains the reason this answer works.
      void audio.speak({
        sessionId: id,
        stepId: currentStep.id,
        part: 'explanation',
        text: observation ? `${observation} ${currentStep.explanation}`.slice(0, 900) : undefined,
        mode: sessionMode,
        speechConfigured: capabilities.speech,
      });
    } else {
      setCheckStatus('incorrect');
      setWrongIds(outcome.wrongIds ?? []);
      setBubbleTone('try');
      setBubbleText(nextAttempts >= 2 && currentStep.hint ? `${outcome.message}\n\nHint: ${currentStep.hint}` : outcome.message);
      setQuickReplies(nextAttempts >= 2 ? ['Try simpler step', 'Show answer'] : ['Give me a hint', 'Show answer']);

      // Ask the agentic tutor to diagnose the exact misconception (or prepare a remedial step on 2+ misses)
      const turn = new AbortController();
      activeTurnRef.current = turn;
      setHelpBusy(true);
      try {
        const { reply, script: updatedScript } = await api.courseTurn(id, {
          stepId: currentStep.id,
          event: 'check',
          mode: 'ui',
          answer,
          answerSummary: summary,
          correct: false,
          attempts: nextAttempts,
          stage: 'practice',
        }, turn.signal);
        if (turn.signal.aborted) return;
        setScript(updatedScript);
        setTurnIntent(reply.intent);
        if (reply.highlight.length) setHighlightIds(reply.highlight);
        if (reply.insertedStep) setInsertedStepId(reply.insertedStep.id);

        if (nextAttempts >= 2 || reply.displayText.length > 130) {
          setSplitExplain(true);
          setBubbleTone('explain');
        }
        setBubbleText(reply.displayText);
        setQuickReplies(
          reply.insertedStep
            ? ['Try simpler step', 'Show answer']
            : reply.replies.length
              ? reply.replies
              : ['Give me a hint', 'Show answer'],
        );
        void persistProgress({
          ...progress,
          history: appendHistory(progress.history, [
            { role: 'learner', text: `Attempt ${nextAttempts} (${summary})`.slice(0, 280), stepId: currentStep.id, intent: 'check-wrong' },
            { role: 'tutor', text: reply.spokenText, stepId: currentStep.id, intent: reply.intent },
          ]),
        });
        void audio.speak({ sessionId: id, text: reply.spokenText, mode: sessionMode, speechConfigured: capabilities.speech });
      } catch {
        // Keep instant deterministic hint already displayed
      } finally {
        if (activeTurnRef.current === turn) cancelTutorTurn();
      }
    }
  }

  function handleWhy() {
    if (!currentStep) return;
    unlockLessonAudio();
    audio.stop();
    setSplitExplain(true);
    setTurnIntent('clarify');
    setBridgeText('');
    setBubbleTone('explain');
    setBubbleText(`${currentStep.explanation}\n\nDoes that make sense?`);
    setQuickReplies(['Yes', 'Explain simpler']);

    void audio.speak({ sessionId: id, stepId: currentStep.id, part: 'explanation', mode: sessionMode, speechConfigured: capabilities.speech });
  }

  async function handleContinue() {
    if (!script || !currentChapter) return;
    cancelTutorTurn();
    unlockLessonAudio();
    audio.stop();

    // Mark pure-concept steps complete when advancing
    const updatedResults = currentStep && !hasQuestion && !progress.results[currentStep.id]
      ? { ...progress.results, [currentStep.id]: { correct: true, attempts: 1, revealed: false, xp: 10 } }
      : progress.results;
    const bonusXp = currentStep && !hasQuestion && !progress.results[currentStep.id] ? 10 : 0;

    // Skip over remedial step if learner already solved the parent step on first try, otherwise move sequentially
    let nextStepIdx = stepIndex + 1;
    while (nextStepIdx < currentChapter.steps.length) {
      const candidate = currentChapter.steps[nextStepIdx]!;
      if (candidate.remedialFor && updatedResults[candidate.remedialFor]?.correct && updatedResults[candidate.remedialFor]!.attempts <= 1) {
        nextStepIdx += 1;
      } else {
        break;
      }
    }

    if (nextStepIdx < currentChapter.steps.length) {
      await persistProgress({
        ...progress,
        xp: progress.xp + bonusXp,
        results: updatedResults,
        chapter: chapterIndex,
        step: nextStepIdx,
        stage: 'teach',
      });
      return;
    }

    if (chapterIndex + 1 < script.chapters.length) {
      await persistProgress({
        ...progress,
        xp: progress.xp + bonusXp,
        results: updatedResults,
        chapter: chapterIndex + 1,
        step: 0,
        stage: 'teach',
      });
      return;
    }

    // All prepared syllabus chapters completed!
    const done: CourseProgress = {
      ...progress,
      xp: progress.xp + bonusXp,
      results: updatedResults,
      completedAt: new Date().toISOString(),
    };
    await persistProgress(done);
    if (session && session.status !== 'ended') {
      try { setSession(await api.end(id)); } catch {}
    }
  }

  function toggleReadAloud() {
    unlockLessonAudio();
    if (audio.speaking) {
      audio.stop();
      return;
    }
    if (!currentStep || !stepTeaching) return;
    dismissedSpeechAlertRef.current = false;
    if ((splitExplain || chatOpen) && bubbleText) {
      void audio.speak({ sessionId: id, text: bubbleText, mode: sessionMode, speechConfigured: capabilities.speech, manual: true });
    } else {
      void audio.speak({
        sessionId: id,
        stepId: currentStep.id,
        part: 'step',
        text: stage === 'teach' ? stepTeaching.combinedSpeech : stepTeaching.questionSpeech || stepTeaching.conceptSpeech,
        mode: sessionMode,
        speechConfigured: capabilities.speech,
        manual: true,
        onStart: () => { if (stage === 'teach') setShowDemo(Boolean(currentStep.demonstration)); },
        onComplete: () => { if (stage === 'teach' && hasQuestion) advanceToPractice(); },
      });
    }
  }

  function handleAnswerChange(next: CourseAnswer) {
    setAnswer(next);
    if (checkStatus === 'incorrect') {
      setCheckStatus('idle');
      setWrongIds([]);
    }
    if (next.type === 'slider' && currentStep?.interaction?.type === 'slider') {
      const bind = currentStep.interaction.bindParam;
      graphChangedRef.current = Boolean(plotControl);
      setParamOverrides(prev => ({ ...prev, ...(bind ? { [bind]: next.value } : {}), __slider: next.value }));
    }
  }

  const observeGraphAnswer = useEffectEvent(() => {
    if (!currentStep?.interaction || !answer || checkStatus === 'correct' || activeTurnRef.current) return;
    if (gradeCourseInteraction(currentStep.interaction, answer).correct) void handleCheck(true);
  });
  useEffect(() => {
    if (stage !== 'practice' || !graphChangedRef.current || answer?.type !== 'slider' || checkStatus === 'correct') return;
    const settled = setTimeout(() => observeGraphAnswer(), 650);
    return () => clearTimeout(settled);
  }, [answer, checkStatus, currentStep?.id, stage]);

  function togglePlotPoint(pt: { x: number; y: number }) {
    if (!currentStep?.interaction || currentStep.interaction.type !== 'mark-points' || checkStatus === 'correct') return;
    const pts = answer?.type === 'mark-points' ? answer.points : [];
    const existingIdx = pts.findIndex(p => Math.hypot(p.x - pt.x, p.y - pt.y) <= 0.45);
    const maxPts = currentStep.interaction.targets.length;
    const nextPts = existingIdx >= 0
      ? pts.filter((_, i) => i !== existingIdx)
      : pts.length >= maxPts
        ? [...pts.slice(1), pt]
        : [...pts, pt];
    handleAnswerChange({ type: 'mark-points', points: nextPts });
  }

  if (loading) {
    return (
      <div className="milli-course-shell">
        <div className="milli-course-loading" role="status">
          <MilliMascot mood="thinking" label="Planning lesson" />
          <div className="milli-course-loading-copy">
            <h2>Planning your lesson…</h2>
            <p>Preparing Concept 1 so we can start right away.</p>
          </div>
          <span className="spinner" />
        </div>
      </div>
    );
  }

  if (error || !script) {
    return (
      <div className="milli-course-shell">
        <div className="milli-course-error-card" role="alert">
          <h2>Couldn’t open this lesson</h2>
          <p>{error || 'This lesson could not be prepared.'}</p>
          <div className="milli-course-error-actions">
            <button type="button" className="milli-course-continue-btn" onClick={() => void load()}>Try again</button>
            <Link href="/" className="milli-course-why-btn">Back to Home</Link>
          </div>
        </div>
      </div>
    );
  }

  const isCompleted = Boolean(progress.completedAt);

  if (isCompleted) {
    return (
      <div className="milli-course-shell is-correct-bg">
        <header className="milli-course-topbar">
          <Link href="/" className="milli-course-close" aria-label="Back to home"><X size={20} /></Link>
          <div className="milli-course-progress-group" aria-label="Lesson complete">
            <div className="milli-course-progress-track"><div className="milli-course-progress-fill" style={{ width: '100%' }} /></div>
          </div>
          <div className="milli-course-xp-cluster">
            <span className="milli-course-xp-val is-earned">{progress.xp} <Sparkles size={16} /></span>
            <Zap size={17} className="milli-course-zap" />
          </div>
        </header>
        <main id="main" className="milli-course-complete-stage">
          <div className="milli-course-complete-card">
            <MilliMascot mood="happy" label="Lesson complete" />
            <span className="milli-course-badge">{session?.mode === 'sample' ? 'Guided sample' : script.provenance === 'authored' ? 'Prepared lesson' : 'Live AI lesson'}</span>
            <h1>{script.title}</h1>
            <p className="milli-course-complete-summary">{script.summary}</p>
            <div className="milli-course-complete-stats">
              <div><strong>{progress.xp}</strong><span>XP earned</span></div>
              <div><strong>{completedSteps}</strong><span>Activities completed</span></div>
              <div><strong>{chapters.length}</strong><span>Chapters finished</span></div>
            </div>
            {script.cards.length > 0 && (
              <section className="milli-course-recall" aria-label="Quick recall">
                <h2>Quick recall</h2>
                {script.cards.slice(0, 3).map((card, index) => (
                  <details key={index}>
                    <summary>{card.front}</summary>
                    <p>{card.back}</p>
                  </details>
                ))}
              </section>
            )}
            <div className="milli-course-complete-actions">
              <Link href="/" className="milli-course-continue-btn">Continue learning</Link>
              <Link href={`/sessions/${id}`} className="milli-course-why-btn">Study pack & recap</Link>
              <button type="button" className="milli-course-why-btn" onClick={() => {
                const notes = [`# ${script.title}`, script.summary, ...script.cards.map(card => `## ${card.front}\n\n${card.back}`)];
                downloadBlob(new Blob([notes.join('\n\n')], { type: 'text/markdown;charset=utf-8' }), 'milli-lesson-notes.md');
              }}>Download notes</button>
              <button
                type="button"
                className="milli-course-start-over"
                onClick={() => void persistProgress(emptyCourseProgress())}
              >
                <RotateCcw size={14} /> Replay lesson
              </button>
            </div>
          </div>
        </main>
      </div>
    );
  }

  // Waiting state if a fast learner reached a chapter still generating in the background
  if (!currentStep || !stepTeaching) {
    return (
      <div className="milli-course-shell">
        <header className="milli-course-topbar">
          <Link href="/" className="milli-course-close" aria-label="Exit lesson"><X size={20} /></Link>
          <div className="milli-course-progress-group">
            <div className="milli-course-progress-track"><div className="milli-course-progress-fill" style={{ width: `${progressPct}%` }} /></div>
          </div>
          <div className="milli-course-xp-cluster">
            <span className="milli-course-xp-val is-earned">{progress.xp} <Sparkles size={16} /></span>
          </div>
        </header>
        <main id="main" className="milli-course-complete-stage">
          <div className="milli-course-complete-card" role="status">
            <MilliMascot mood="thinking" label="Preparing next concept" />
            <span className="milli-course-badge">Adapting to your progress</span>
            <h2>Finishing {currentChapter?.title || 'your next concept'}…</h2>
            <p className="milli-course-complete-summary">milli is crafting the next interactive step on your study track.</p>
            <span className="spinner" />
          </div>
        </main>
      </div>
    );
  }

  const mascotMood: MascotMood =
    helpBusy || mic.state === 'transcribing'
      ? 'thinking'
      : mic.state === 'listening'
        ? 'listening'
        : audio.speaking
          ? 'speaking'
          : checkStatus === 'correct'
            ? 'happy'
            : checkStatus === 'incorrect'
              ? 'curious'
              : 'idle';

  const readyToCheck = currentStep.interaction ? isCourseAnswerReady(currentStep.interaction, answer) : true;
  const activeHighlights = highlightIds.length > 0 ? highlightIds : (stage === 'teach' ? stepTeaching.highlightIds : []);
  const demonstration = currentStep.demonstration;
  const demoLabel = currentStep.visual?.kind === 'plot' && demonstration
    ? currentStep.visual.params.find(param => param.name === demonstration.parameter)?.label
    : undefined;
  const visualParams = stage === 'teach' && showDemo && demonstration
    ? { ...paramOverrides, [demonstration.parameter]: demonstration.value }
    : answer?.type === 'slider'
      ? { ...paramOverrides, ...(plotControl ? { [plotControl]: answer.value } : {}), __slider: answer.value }
      : paramOverrides;

  return (
    <div className={`milli-course-shell ${checkStatus === 'correct' ? 'is-correct-bg' : ''}`}>
      {/* Minimal milli top bar */}
      <header className="milli-course-topbar">
        <Link href="/" className="milli-course-close" aria-label="Exit lesson">
          <X size={20} />
        </Link>

        <div className="milli-course-progress-wrap">
          <div className="milli-course-progress-group" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPct} aria-label="Lesson progress">
            <div className="milli-course-progress-track">
              <div className="milli-course-progress-fill" style={{ width: `${progressPct}%` }} />
            </div>
            <button
              type="button"
              className="milli-course-chapter-dots-btn"
              aria-label="View lesson syllabus track"
              aria-expanded={syllabusOpen}
              title="Lesson study track"
              onClick={() => setSyllabusOpen(o => !o)}
            >
              {chapters.map((ch, idx) => (
                <span
                  key={ch.id}
                  className={`milli-course-chapter-dot ${idx < chapterIndex ? 'is-done' : idx === chapterIndex ? 'is-current' : ch.status === 'pending' ? 'is-pending' : ''}`}
                />
              ))}
            </button>
          </div>

          {syllabusOpen && (
            <div className="milli-course-syllabus-popover" role="dialog" aria-label="Prepared study track">
              <div className="milli-course-syllabus-head">
                <span><ListChecks size={14} /> Study track</span>
                <button type="button" aria-label="Close study track" onClick={() => setSyllabusOpen(false)}><X size={14} /></button>
              </div>
              <ul className="milli-course-syllabus-list">
                {chapters.map((ch, idx) => {
                  const isDone = idx < chapterIndex;
                  const isCurrent = idx === chapterIndex;
                  const isPending = ch.status === 'pending' || ch.steps.length === 0;
                  return (
                    <li key={ch.id} className={isCurrent ? 'is-current' : isDone ? 'is-done' : ''}>
                      <span className="milli-course-syl-icon">
                        {isDone ? <Check size={12} /> : isPending ? <span className="milli-course-mini-pulse" /> : idx + 1}
                      </span>
                      <div>
                        <strong>{ch.title}</strong>
                        <small>{isPending ? 'Preparing in background…' : ch.goal}</small>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>

        <div className="milli-course-xp-cluster" aria-label={`${progress.xp} experience points`}>
          <button
            type="button"
            className={`milli-course-voice-toggle ${audio.muted ? 'is-muted' : audio.speaking ? 'is-speaking' : ''}`}
            aria-label={audio.muted ? 'Unmute tutor voice' : 'Mute tutor voice'}
            title={audio.muted ? 'Tutor voice muted (click to unmute)' : 'Tutor voice active'}
            onClick={() => {
              unlockLessonAudio();
              audio.setMuted(m => !m);
            }}
          >
            {audio.muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
          </button>
          <span className="milli-course-mode-tag" title={session?.mode === 'sample' ? 'Prepared sample lesson (not live AI)' : script.provenance === 'authored' ? 'Prepared lesson with live voice and tutor replies when available' : 'Live AI adaptive tutor'}>
            {session?.mode === 'sample' ? 'Sample' : script.provenance === 'authored' ? 'Guided · Live tutor' : 'Live AI'}
          </span>
          <span className={`milli-course-xp-val ${progress.xp > 0 ? 'is-earned' : ''}`}>
            {progress.xp} <Sparkles size={16} />
          </span>
          <Zap size={17} className="milli-course-zap" />
        </div>
      </header>

      {/* Main stage: left adaptive companion column + centered interactive card */}
      <main id="main" className={`milli-course-stage ${isPanelOpen ? 'is-split has-chat-open' : ''}`}>
        {isPanelOpen && (
          <aside className="milli-course-explain-column milli-course-chat-panel" aria-label="milli tutor conversation">
            <header className="milli-course-chat-header">
              <div className="milli-course-chat-tutor-meta">
                <span className="milli-course-chat-avatar">
                  <MilliMascot mood={helpBusy ? 'thinking' : mascotMood} label="milli" />
                </span>
                <div className="milli-course-chat-tutor-titles">
                  <strong>milli</strong>
                  <span className="milli-course-chat-status">
                    {helpBusy
                      ? 'Thinking…'
                      : audio.speaking
                        ? 'Explaining aloud'
                        : mic.state === 'listening'
                          ? 'Listening to you…'
                          : session?.mode === 'live'
                            ? '1-on-1 AI Tutor'
                            : 'Sample Course Tutor'}
                  </span>
                </div>
              </div>
              <div className="milli-course-chat-header-actions">
                <button
                  type="button"
                  className={`milli-course-rail-btn ${flaggedSteps[currentStep.id] ? 'is-flagged' : ''}`}
                  aria-label="Report an issue with this step"
                  title={flaggedSteps[currentStep.id] ? 'Step flagged for review' : 'Report an issue with this step'}
                  onClick={() => setFlaggedSteps(f => ({ ...f, [currentStep.id]: !f[currentStep.id] }))}
                >
                  <Flag size={15} />
                </button>
                <button
                  type="button"
                  className={`milli-course-rail-btn ${audio.speaking ? 'is-active' : ''}`}
                  aria-label={audio.speaking ? 'Stop reading aloud' : 'Read explanation aloud'}
                  title={audio.speaking ? 'Stop speaking' : 'Read explanation aloud'}
                  onClick={toggleReadAloud}
                >
                  <Volume2 size={16} />
                </button>
                <button
                  type="button"
                  className="milli-course-chat-close-btn"
                  aria-label="Close tutor conversation panel"
                  title="Close panel"
                  onClick={() => {
                    setChatOpen(false);
                    setSplitExplain(false);
                    userInteractingRef.current = false;
                  }}
                >
                  <X size={16} />
                </button>
              </div>
            </header>

            <div className="milli-course-chat-scroll">
              {progress.history && progress.history.length > 0 && (
                <div className="milli-course-chat-thread">
                  {progress.history
                    .filter(h => h.stepId === currentStep.id || !h.stepId)
                    .slice(-4)
                    .map((item, idx) => (
                      <div
                        key={`${item.stepId}-${idx}`}
                        className={`milli-course-chat-msg is-${item.role}`}
                      >
                        <span className="milli-course-chat-msg-role">
                          {item.role === 'learner' ? 'You' : 'milli'}
                        </span>
                        <div className="milli-course-chat-msg-bubble">
                          <FormattedStepText text={item.text} />
                        </div>
                      </div>
                    ))}
                </div>
              )}

              <div className={`milli-course-explain-bubble ${turnIntent === 'side-question' ? 'is-side-q' : ''}`} role="status">
                {turnIntent === 'side-question' && (
                  <span className="milli-course-intent-tag">Answered your question</span>
                )}
                {turnIntent === 'remedial' && (
                  <span className="milli-course-intent-tag is-amber">Let’s break it down</span>
                )}
                {turnIntent === 'affirm' && (
                  <span className="milli-course-intent-tag is-green">Spot on!</span>
                )}
                {helpBusy ? (
                  <div className="milli-course-thinking-inline">
                    <span className="spinner" /> <span>milli is thinking…</span>
                  </div>
                ) : (
                  <FormattedStepText
                    text={
                      bubbleText ||
                      "I'm right here with you! Ask me anything about this concept, ask for a hint, or answer in your own words."
                    }
                  />
                )}

                {clarifyVisual && !helpBusy && (
                  <div className="milli-course-clarify-visual">
                    <CourseVisualRenderer visual={clarifyVisual} />
                  </div>
                )}
              </div>

              {/* Smooth re-anchoring bridge back to the prepared syllabus track after answering an off-script question */}
              {bridgeText && !helpBusy && (
                <div className="milli-course-bridge-card">
                  <div className="milli-course-bridge-head">
                    <Compass size={14} /> <span>Back on our lesson track</span>
                  </div>
                  <FormattedStepText text={bridgeText} />
                </div>
              )}

              {/* Quick suggestion replies */}
              {(!helpBusy && (quickReplies.length > 0 || !bubbleText)) && (
                <div className="milli-course-quick-replies" role="group" aria-label="Quick responses">
                  {(quickReplies.length > 0
                    ? quickReplies
                    : ['Can you explain simply?', 'Give me a hint', 'Why does this work?']
                  ).map(reply => (
                    <button
                      key={reply}
                      type="button"
                      disabled={helpBusy}
                      className={`milli-course-reply-btn ${reply === 'Try simpler step' || reply === 'Yes' ? 'is-accent' : ''}`}
                      onClick={() => void askCompanion(reply, 'typed')}
                    >
                      {reply}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <form
              className="milli-course-drawer-form"
              onSubmit={e => {
                e.preventDefault();
                if (chatInput.trim()) {
                  void askCompanion(chatInput, 'typed');
                }
              }}
            >
              <input
                ref={chatInputRef}
                type="text"
                value={chatInput}
                disabled={helpBusy}
                maxLength={500}
                placeholder={helpBusy ? 'milli is thinking…' : 'Ask milli anything or answer here…'}
                aria-label="Ask milli any question"
                onChange={e => {
                  userInteractingRef.current = true;
                  setChatInput(e.target.value);
                }}
              />
              <button
                type="button"
                className="milli-course-inline-mic-btn"
                aria-label="Speak to milli with voice"
                title="Speak (v)"
                disabled={helpBusy}
                onClick={handleTriggerMic}
              >
                <Mic size={15} />
              </button>
              <button
                type="submit"
                disabled={!chatInput.trim() || helpBusy}
                className="milli-course-drawer-send"
                aria-label="Send message"
              >
                <Send size={13} />
              </button>
            </form>
          </aside>
        )}

        <section
          className={`milli-course-card ${checkStatus === 'correct' ? 'is-correct' : checkStatus === 'incorrect' ? 'is-wrong' : ''}`}
          aria-label={currentStep.title || 'Lesson step'}
        >
          {!isPanelOpen && (
            <div className="milli-course-card-rail">
              <button
                type="button"
                className={`milli-course-rail-btn ${flaggedSteps[currentStep.id] ? 'is-flagged' : ''}`}
                aria-label="Report an issue with this step"
                title={flaggedSteps[currentStep.id] ? 'Step flagged for review' : 'Report an issue with this step'}
                onClick={() => setFlaggedSteps(f => ({ ...f, [currentStep.id]: !f[currentStep.id] }))}
              >
                <Flag size={16} />
              </button>
              <button
                type="button"
                className={`milli-course-rail-btn ${audio.speaking ? 'is-active' : ''}`}
                aria-label={audio.speaking ? 'Stop reading aloud' : 'Read step aloud'}
                title={audio.speaking ? 'Stop speaking' : 'Speak aloud'}
                onClick={toggleReadAloud}
              >
                <Volume2 size={17} />
              </button>
            </div>
          )}

          <div className="milli-course-card-scroll">
            <div className="milli-course-card-body">
              <div className="milli-course-step-meta">
                <span className={`milli-course-stage-pill ${currentStep.remedialFor ? 'is-remedial' : stage === 'teach' ? 'is-teach' : 'is-practice'}`}>
                  {currentStep.remedialFor
                    ? 'Stepping stone'
                    : stage === 'teach'
                      ? `Concept ${chapterIndex + 1}.${stepIndex + 1}`
                      : `Your turn · ${chapterIndex + 1}.${stepIndex + 1}`}
                </span>
                {audio.speaking && (
                  <span className="milli-course-speaking-pill" aria-live="polite">
                    <span className="milli-course-wave-bars" aria-hidden="true"><i /><i /><i /></span>
                    milli is speaking
                  </span>
                )}
                {audio.needsTapToPlay && !audio.muted && (
                  <button type="button" className="milli-course-tap-audio-btn" onClick={audio.replayLast}>
                    <Volume2 size={13} /> Tap to hear milli
                  </button>
                )}
                {preparingChapterIdx !== null && (
                  <span className="milli-course-bg-prep" title="Next concepts are preparing in the background">
                    Next chapter ready soon
                  </span>
                )}
              </div>

              {speechAlert && (
                <div className="milli-course-speech-alert" role="alert">
                  <VolumeX size={16} aria-hidden="true" className="milli-course-speech-alert-icon" />
                  <span>{speechAlert}</span>
                  <div className="milli-course-speech-alert-actions">
                    <button
                      type="button"
                      className="milli-course-speech-chat-btn"
                      onClick={() => {
                        setChatOpen(true);
                        setTimeout(() => chatInputRef.current?.focus(), 20);
                      }}
                    >
                      Chat
                    </button>
                    <button
                      type="button"
                      className="milli-course-speech-dismiss"
                      aria-label="Dismiss voice notice"
                      onClick={() => {
                        dismissedSpeechAlertRef.current = true;
                        setSpeechAlert('');
                        audio.clearSpeechError();
                      }}
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              )}

              {currentStep.title && <h1 className="milli-course-step-title">{currentStep.title}</h1>}

              {/* Concept explanation text */}
              {stepTeaching.conceptText && (
                <div className={`milli-course-concept-prose ${stage === 'practice' && stepTeaching.questionPrompt ? 'is-compact' : ''}`}>
                  <FormattedStepText text={stepTeaching.conceptText} />
                </div>
              )}

              {/* Interactive SVG diagram / simulation */}
              {currentStep.visual && (
                <CourseVisualRenderer
                  visual={currentStep.visual}
                  highlight={activeHighlights}
                  markedPoints={answer?.type === 'mark-points' ? answer.points : []}
                  onTogglePoint={togglePlotPoint}
                  interactivePoints={stage === 'practice' && currentStep.interaction?.type === 'mark-points' && checkStatus !== 'correct'}
                  paramOverrides={visualParams}
                  onParamChange={(!plotControl && !demonstration) || (stage === 'practice' && checkStatus !== 'correct') ? (name, value) => {
                    if (name === plotControl) handleAnswerChange({ type: 'slider', value });
                    else setParamOverrides(prev => ({ ...prev, [name]: value }));
                  } : undefined}
                />
              )}

              {stage === 'teach' && demonstration && demoLabel && (
                <div className="milli-course-question-section">
                  <button type="button" className="milli-course-why-btn" onClick={() => setShowDemo(value => !value)}>
                    {showDemo ? 'Reset demonstration' : 'Watch milli adjust the graph'}
                  </button>
                  {showDemo && <p role="status">Milli set {demoLabel} to {demonstration.value}. {stepTeaching.conceptText}</p>}
                </div>
              )}

              {stage === 'practice' && hasQuestion && (
                <div ref={questionSectionRef} className="milli-course-question-section">
                  {stepTeaching.questionPrompt && (
                    <div className="milli-course-question-prompt">
                      <FormattedStepText text={stepTeaching.questionPrompt} />
                    </div>
                  )}
                  {currentStep.interaction && !plotControl && <CourseInteractionWidget
                    interaction={currentStep.interaction}
                    answer={answer}
                    onChange={handleAnswerChange}
                    locked={checkStatus === 'correct'}
                    status={checkStatus}
                    wrongIds={wrongIds}
                    onReset={() => {
                      setAnswer(initialCourseAnswer(currentStep.interaction));
                      setCheckStatus('idle');
                      setWrongIds([]);
                    }}
                  />}
                  {checkStatus !== 'correct' && (
                    <div className="milli-course-answer-options">
                      {sessionMode === 'live' && capabilities.speech && (
                        <button type="button" className="milli-course-why-btn" onClick={handleTriggerMic}
                          disabled={helpBusy || mic.state === 'permission' || mic.state === 'connecting' || mic.state === 'transcribing'}>
                          <Mic size={16} /> {mic.state === 'listening' ? 'Send spoken answer' : 'Say your answer'}
                        </button>
                      )}
                      {!currentStep.spokenQuestion && !showAnswerInput && (
                        <button type="button" className="milli-course-why-btn" onClick={() => setShowAnswerInput(true)}>Type an answer</button>
                      )}
                      {(currentStep.spokenQuestion || showAnswerInput) && (
                        <form className="milli-course-answer-form" onSubmit={event => {
                          event.preventDefault();
                          void askCompanion(chatInput, 'typed', true);
                        }}>
                          <input aria-label="Your answer" placeholder="Answer in your own words" value={chatInput}
                            onChange={event => setChatInput(event.target.value)} maxLength={3000} />
                          <button type="submit" className="milli-course-why-btn" disabled={helpBusy || !chatInput.trim()}>Send answer</button>
                        </form>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Non-overlapping feedback bubble inside card when not in split-view */}
          {!isPanelOpen && bubbleText && (
            <div className={`milli-course-floating-bubble is-${bubbleTone}`} role="status">
              <FormattedStepText text={bubbleText} />
              {quickReplies.length > 0 && (
                <div className="milli-course-bubble-chips">
                  {quickReplies.map(r => (
                    <button key={r} type="button" onClick={() => void askCompanion(r, 'typed')}>
                      {r}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Bottom action bar inside card */}
          <footer className="milli-course-card-footer">
            {stage === 'teach' && hasQuestion ? (
              <button
                type="button"
                className="milli-course-continue-btn"
                onClick={() => {
                  cancelTutorTurn();
                  unlockLessonAudio();
                  audio.stop();
                  advanceToPractice(stepTeaching.questionSpeech);
                }}
              >
                Ready for question <ArrowRight size={17} style={{ marginLeft: 6 }} />
              </button>
            ) : checkStatus === 'correct' || !hasQuestion ? (
              <div className="milli-course-footer-done">
                {hasQuestion && (
                  <button
                    type="button"
                    className={`milli-course-why-btn ${isPanelOpen ? 'is-muted' : ''}`}
                    onClick={() => void handleWhy()}
                  >
                    Why?
                  </button>
                )}
                <button type="button" className="milli-course-continue-btn" onClick={() => void handleContinue()}>
                  Continue
                </button>
              </div>
            ) : currentStep.interaction ? (
              <button
                type="button"
                disabled={!readyToCheck || helpBusy}
                className="milli-course-check-btn"
                onClick={() => void handleCheck()}
              >
                Check
              </button>
            ) : null}
          </footer>
        </section>
      </main>

      {/* Bottom-left milli companion dock */}
      <div className="milli-course-companion-dock">
        <div className="milli-course-companion-row">
          <MilliMascot
            mood={mascotMood}
            onClick={() => {
              unlockLessonAudio();
              if (!isPanelOpen && checkStatus === 'correct') {
                void handleWhy();
              } else {
                setChatOpen(o => !o);
                setTimeout(() => chatInputRef.current?.focus(), 40);
              }
            }}
          />

          {mic.state !== 'idle' ? (
            <div className="milli-course-mic-live-pill" role="status" aria-live="polite">
              <span
                className="milli-course-mic-dot"
                style={{ transform: `scale(${1 + mic.level * 0.65})` }}
              />
              <span className="milli-course-mic-label">
                {mic.state === 'connecting' ? 'Connecting microphone…' : mic.state === 'permission'
                  ? 'Allow mic…'
                  : mic.state === 'transcribing'
                    ? 'Understanding…'
                    : `Listening · ${mic.seconds}s`}
              </span>
              {mic.state === 'listening' && (
                <button
                  type="button"
                  className="milli-course-mic-send"
                  aria-label="Send spoken message now"
                  title="Send now"
                  onClick={() => mic.stopAndSend()}
                >
                  <Send size={13} />
                </button>
              )}
              <button
                type="button"
                className="milli-course-mic-cancel"
                aria-label="Cancel voice recording"
                title="Cancel"
                onClick={mic.cancel}
              >
                <X size={14} />
              </button>
            </div>
          ) : !isPanelOpen ? (
            <div className="milli-course-dock-pill" role="group" aria-label="Tutor input controls">
              <button
                type="button"
                aria-label="Ask milli anything by typing (shortcut /)"
                title="Ask anything or type answer (/)"
                onClick={() => {
                  audio.stop();
                  userInteractingRef.current = true;
                  setChatOpen(true);
                  setTimeout(() => chatInputRef.current?.focus(), 40);
                }}
              >
                <MessageSquare size={16} />
              </button>
              <span className="milli-course-dock-divider" aria-hidden="true" />
              <button
                type="button"
                aria-label="Talk to milli with voice (shortcut v)"
                title="Speak to milli (v)"
                onClick={handleTriggerMic}
              >
                <Mic size={16} />
              </button>
            </div>
          ) : null}
        </div>

        {!isPanelOpen && (
          <div className="milli-course-shortcut-hint" aria-hidden="true">
            ask anything <kbd>/</kbd> · speak <kbd>v</kbd>
          </div>
        )}
      </div>
    </div>
  );
}
