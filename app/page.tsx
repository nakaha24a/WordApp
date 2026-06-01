"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Papa from "papaparse";
import { createClient } from "@supabase/supabase-js";

// ── Supabaseクライアントの初期化 ──
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const supabase = createClient(supabaseUrl, supabaseAnonKey);

interface Word {
  word: string;
  pinyin: string;
  meaning: string;
}

interface Deck {
  id: string;
  name: string;
  words: Word[];
}

type Screen = "home" | "study" | "result";

interface Session {
  queue: number[];
  current: number;
  learned: number[];
  notYet: number[];
  randomMode: boolean;
  reverseMode: boolean;
}

export default function Home() {
  const [secretKey, setSecretKey] = useState(""); // あなた専用の合言葉
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);

  const [decks, setDecks] = useState<Deck[]>([]);
  const [activeDeck, setActiveDeck] = useState<Deck | null>(null);
  const [screen, setScreen] = useState<Screen>("home");
  
  // 学習用State
  const [queue, setQueue] = useState<number[]>([]);
  const [current, setCurrent] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [learned, setLearned] = useState<Set<number>>(new Set());
  const [notYet, setNotYet] = useState<Set<number>>(new Set());
  const [isFlipping, setIsFlipping] = useState(false);
  const [randomMode, setRandomMode] = useState(false);
  const [reverseMode, setReverseMode] = useState(false);
  
  // セッション保存用
  const [savedSessions, setSavedSessions] = useState<Record<string, Session>>({});

  const [dragOver, setDragOver] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
  const synthRef = useRef<SpeechSynthesis | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // CSVインポート用State
  const [pendingWords, setPendingWords] = useState<Word[]>([]);
  const [pendingFileName, setPendingFileName] = useState("");
  const [showImportModal, setShowImportModal] = useState(false);

  // 単語編集用State
  const [editForm, setEditForm] = useState<Word | null>(null);

  // 初回マウント時：ブラウザに記憶している合言葉があれば自動ログイン
  useEffect(() => {
    synthRef.current = window.speechSynthesis;
    const savedKey = localStorage.getItem("flashcard-secret-key");
    if (savedKey) {
      setSecretKey(savedKey);
      loadCloudData(savedKey);
    } else {
      setAuthLoading(false);
    }
  }, []);

  // ── クラウドデータベース(Supabase)からデータを取得・同期 ──
  const loadCloudData = async (key: string) => {
    setAuthLoading(true);
    try {
      const { data, error } = await supabase
        .from("user_data")
        .select("decks, sessions")
        .eq("id", key)
        .maybeSingle();

      if (error) {
        console.error("load error", error);
        throw error;
      }

      // 💡 修正：構文の崩れを直し、クラウドデータの存在チェックを安全に行う
      if (data && data.decks && data.decks.length > 0) {
        setDecks(data.decks);
        if (data.sessions) setSavedSessions(data.sessions);
        setIsAuthorized(true);
        localStorage.setItem("flashcard-secret-key", key);
      } else {
        // まだクラウドにデータがない新規の合言葉、または空だった場合、デフォルトのHSK3級をセット
        const res = await fetch("/hsk3.csv");
        if (!res.ok) throw new Error();
        const text = await res.text();
        const result = Papa.parse<Word>(text, { header: true, skipEmptyLines: true });
        
        if (result.data.length > 0) {
          const defaultDeck: Deck = { id: "default", name: "HSK3級", words: result.data };
          setDecks([defaultDeck]);
          
          // 初期状態を保存
          await supabase.from("user_data").upsert({
            id: key,
            decks: [defaultDeck],
            sessions: {}
          });
          setIsAuthorized(true);
          localStorage.setItem("flashcard-secret-key", key);
        }
      }
    } catch (e) {
      // CSV読み込みエラーやネットワークエラー時のフォールバック
      setIsAuthorized(true);
      localStorage.setItem("flashcard-secret-key", key);
    } finally {
      setAuthLoading(false);
    }
  };

  // ── クラウドへのセーブ関数 ──
  const saveToCloud = async (nextDecks: Deck[], nextSessions: Record<string, Session>) => {
    if (!isAuthorized || !secretKey) return;
    // 💡 データの誤上書きを防ぐ超重要ガード：読み込み中、またはデッキが完全に空の時はクラウド保存を絶対に走らせない
    if (authLoading || nextDecks.length === 0) return;

    await supabase.from("user_data").upsert({
      id: secretKey,
      decks: nextDecks,
      sessions: nextSessions,
      updated_at: new Date()
    });
  };

  // 💡 学習中の進捗をオートセーブ（ユーザーの操作によるState変更時のみ連動）
  useEffect(() => {
    // 💡 authLoading中は絶対に処理しない
    if (authLoading) return;
    
    if (activeDeck && screen === "study" && isAuthorized && decks.length > 0) {
      const updatedSessions = {
        ...savedSessions,
        [activeDeck.id]: {
          queue,
          current,
          learned: Array.from(learned),
          notYet: Array.from(notYet),
          randomMode,
          reverseMode,
        },
      };
      setSavedSessions(updatedSessions);
      saveToCloud(decks, updatedSessions);
    }
  }, [queue, current, learned, notYet, randomMode, reverseMode]);

  // 合言葉入力時の処理
  const handleAuthSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!secretKey.trim()) return;
    loadCloudData(secretKey.trim());
  };

  const handleLogout = () => {
    localStorage.removeItem("flashcard-secret-key");
    setSecretKey("");
    setIsAuthorized(false);
    setDecks([]);
    setSavedSessions({});
    setScreen("home");
  };

  // ── デッキ操作関連 (クラウド保存を連動) ──
  const saveNewDeck = (name: string, words: Word[]) => {
    const deck: Deck = { id: Date.now().toString(), name, words };
    const nextDecks = [...decks, deck];
    setDecks(nextDecks);
    saveToCloud(nextDecks, savedSessions);
    closeImportModal();
  };

  const appendToExistingDeck = (deckId: string, newWords: Word[]) => {
    const nextDecks = decks.map((d) => d.id === deckId ? { ...d, words: [...d.words, ...newWords] } : d);
    const nextSessions = { ...savedSessions };
    delete nextSessions[deckId];
    
    setDecks(nextDecks);
    setSavedSessions(nextSessions);
    saveToCloud(nextDecks, nextSessions);
    
    alert("選択したデッキに単語を追加しました！");
    closeImportModal();
  };

  const deleteDeck = (id: string) => {
    const nextDecks = decks.filter((d) => d.id !== id);
    setDecks(nextDecks);
    saveToCloud(nextDecks, savedSessions);
  };

  const renameDeck = (id: string, name: string) => {
    const nextDecks = decks.map((d) => d.id === id ? { ...d, name } : d);
    setDecks(nextDecks);
    saveToCloud(nextDecks, savedSessions);
    setRenamingId(null);
  };

  const saveWordEdit = () => {
    if (!activeDeck || !editForm) return;
    const currentWordIndex = queue[current >= queue.length ? queue.length - 1 : current];
    
    const nextDecks = decks.map((d) => {
      if (d.id !== activeDeck.id) return d;
      const newWords = [...d.words];
      newWords[currentWordIndex] = editForm;
      return { ...d, words: newWords };
    });

    setDecks(nextDecks);
    saveToCloud(nextDecks, savedSessions);
    setActiveDeck((prev) => {
      if (!prev) return prev;
      const newWords = [...prev.words];
      newWords[currentWordIndex] = editForm;
      return { ...prev, words: newWords };
    });
    setEditForm(null);
  };

  const handleFiles = (files: FileList) => {
    const file = files[0];
    if (!file || !file.name.endsWith(".csv")) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const result = Papa.parse<Word>(text, { header: true, skipEmptyLines: true });
      if (result.data.length > 0) {
        setPendingWords(result.data);
        setPendingFileName(file.name.replace(".csv", ""));
        setShowImportModal(true);
      }
    };
    reader.readAsText(file, "UTF-8");
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) handleFiles(e.target.files);
    e.target.value = "";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files) handleFiles(e.dataTransfer.files);
  };

  const closeImportModal = () => {
    setPendingWords([]);
    setPendingFileName("");
    setShowImportModal(false);
  };

  const startDeck = (deck: Deck) => {
    setActiveDeck(deck);
    const session = savedSessions[deck.id];
    
    if (session && session.current < session.queue.length) {
      setQueue(session.queue);
      setCurrent(session.current);
      setLearned(new Set(session.learned));
      setNotYet(new Set(session.notYet));
      setRandomMode(session.randomMode);
      setReverseMode(session.reverseMode || false);
    } else {
      setQueue(Array.from({ length: deck.words.length }, (_, i) => i));
      setCurrent(0);
      setLearned(new Set());
      setNotYet(new Set());
      setRandomMode(false);
      setReverseMode(false);
    }
    
    setFlipped(false);
    setIsFlipping(false);
    setScreen("study");
  };

  const goHome = () => {
    setActiveDeck(null);
    setScreen("home");
  };

  const resetDeck = () => {
    if (!activeDeck) return;
    const newQueue = Array.from({ length: activeDeck.words.length }, (_, i) => i);
    if (randomMode) {
      for (let i = newQueue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newQueue[i], newQueue[j]] = [newQueue[j], newQueue[i]];
      }
    }
    setQueue(newQueue);
    setCurrent(0);
    setLearned(new Set());
    setNotYet(new Set());
    setFlipped(false);
    if (screen === "result") setScreen("study");
  };

  const reviewNotYet = () => {
    if (!activeDeck || notYet.size === 0) return;
    const newQueue = Array.from(notYet);
    if (randomMode) {
      for (let i = newQueue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newQueue[i], newQueue[j]] = [newQueue[j], newQueue[i]];
      }
    }
    setQueue(newQueue);
    setCurrent(0);
    setLearned(new Set());
    setNotYet(new Set());
    setFlipped(false);
    setScreen("study");
  };

  const toggleRandom = () => {
    setRandomMode((prev) => {
      const nextRandom = !prev;
      setQueue((q) => {
        const past = q.slice(0, current);
        const future = q.slice(current);
        if (nextRandom) {
          for (let i = future.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [future[i], future[j]] = [future[j], future[i]];
          }
        } else {
          future.sort((a, b) => a - b);
        }
        return [...past, ...future];
      });
      return nextRandom;
    });
  };

  const speak = useCallback((text: string) => {
    if (!synthRef.current) return;
    synthRef.current.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "zh-CN";
    utter.rate = 0.85;
    synthRef.current.speak(utter);
  }, []);

  useEffect(() => {
    if (screen === "study" && activeDeck && queue.length > 0) {
      const currentWord = activeDeck.words[queue[current]]?.word || "";
      if (!reverseMode && !flipped) {
        speak(currentWord);
      } else if (reverseMode && flipped) {
        speak(currentWord);
      }
    }
  }, [current, flipped, screen, activeDeck, queue, reverseMode, speak]);

  const handleFlip = () => {
    if (isFlipping || editForm) return;
    setIsFlipping(true);
    setTimeout(() => setIsFlipping(false), 600);
    setFlipped((f) => !f);
  };

  const goNext = (action: "learned" | "notYet" | "skip") => {
    if (!activeDeck || queue.length === 0) return;
    const wordIndex = queue[current];

    if (action === "learned") {
      setLearned((s) => new Set(s).add(wordIndex));
      setNotYet((s) => { const n = new Set(s); n.delete(wordIndex); return n; });
    } else if (action === "notYet") {
      setNotYet((s) => new Set(s).add(wordIndex));
      setLearned((s) => { const n = new Set(s); n.delete(wordIndex); return n; });
    }

    setFlipped(false);
    setTimeout(() => {
      if (current + 1 < queue.length) {
        setCurrent((c) => c + 1);
      } else {
        setCurrent(queue.length);
        setScreen("result");
      }
    }, 100);
  };

  const goPrev = () => {
    if (current === 0) return;
    setFlipped(false);
    setTimeout(() => setCurrent((c) => c - 1), 100);
  };

  if (authLoading) {
    return <div style={s.root}><p style={{color: "#fff"}}>クラウドと同期中...</p></div>;
  }

  if (!isAuthorized) {
    return (
      <div style={s.root}>
        <div style={s.blob1} /><div style={s.blob2} />
        <main style={s.authMain}>
          <div style={{textAlign: "center", marginBottom: 10}}>
            <span style={s.logoHan}>漢</span>
            <h2 style={s.logoTitle}>単語帳同期ツール</h2>
            <p style={s.logoSub}>あなただけの「合言葉」を入力してください</p>
          </div>
          <form onSubmit={handleAuthSubmit} style={s.authForm}>
            <input 
              style={s.editInput} 
              type="text" 
              placeholder="例: myhsk3" 
              value={secretKey} 
              onChange={(e) => setSecretKey(e.target.value)} 
            />
            <button type="submit" style={{...s.modalActionBtn, marginTop: 10}}>
              同期して開始する
            </button>
          </form>
        </main>
      </div>
    );
  }

  if (screen === "home") {
    return (
      <div style={s.root}>
        <div style={s.blob1} /><div style={s.blob2} />
        <main style={s.homeMain}>
          <div style={s.homeLogo}>
            <span style={s.logoHan}>漢</span>
            <div style={{flex: 1}}>
              <p style={s.logoTitle}>単語帳</p>
              <p style={s.logoSub}>同期キー: {secretKey}</p>
            </div>
            <button style={s.logoutBtn} onClick={handleLogout}>別のキーに変更</button>
          </div>

          <div
            style={{ ...s.dropZone, ...(dragOver ? s.dropZoneActive : {}) }}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <span style={{ fontSize: 28 }}>＋</span>
            <p style={s.dropText}>CSVをドロップ、または選択して追加</p>
            <p style={s.dropSub}>word, pinyin, meaning の形式</p>
            <input ref={fileInputRef} type="file" accept=".csv" style={{ display: "none" }} onChange={handleFileInput} />
          </div>

          {decks.length === 0 ? (
            <p style={s.emptyText}>まだデッキがありません。CSVを追加してください。</p>
          ) : (
            <div style={s.deckList}>
              {decks.map((deck) => {
                const session = savedSessions[deck.id];
                let progressPercent = 0;
                let learnedCount = 0;
                if (session && session.queue) {
                  learnedCount = session.learned.length;
                  progressPercent = Math.min(100, Math.round((session.current / session.queue.length) * 100));
                }

                return (
                  <div key={deck.id} style={s.deckCard}>
                    {renamingId === deck.id ? (
                      <input
                        style={s.renameInput}
                        value={renameVal}
                        autoFocus
                        onChange={(e) => setRenameVal(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") renameDeck(deck.id, renameVal);
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                        onBlur={() => renameDeck(deck.id, renameVal)}
                      />
                    ) : (
                      <div style={s.deckInfo} onClick={() => startDeck(deck)}>
                        <p style={s.deckName}>{deck.name}</p>
                        <div style={s.deckMetaRow}>
                          <span style={s.deckCount}>{deck.words.length} 単語</span>
                          {progressPercent > 0 && (
                            <span style={{...s.deckBadge, background: progressPercent === 100 ? "rgba(40,200,100,0.15)" : "rgba(255,255,255,0.06)", color: progressPercent === 100 ? "#4ade80" : "rgba(255,255,255,0.5)"}}>
                              {progressPercent === 100 ? "✓ 完了" : `進行度: ${progressPercent}%`} (習得: {learnedCount})
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                    <div style={s.deckActions}>
                      <button style={s.deckBtn} onClick={() => startDeck(deck)}>学習</button>
                      <button style={s.deckBtn} onClick={() => { setRenamingId(deck.id); setRenameVal(deck.name); }}>✏️</button>
                      <button style={{ ...s.deckBtn, ...s.deckBtnDelete }} onClick={() => deleteDeck(deck.id)}>🗑</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </main>

        {showImportModal && (
          <div style={s.modalOverlay}>
            <div style={s.modalCard}>
              <h3 style={s.modalTitle}>CSVの追加方法を選択</h3>
              <p style={s.modalSub}>読み込んだファイル: <strong>{pendingFileName}.csv</strong> ({pendingWords.length}単語)</p>
              
              <div style={s.modalSection}>
                <p style={s.modalLabel}>① 新しいデッキとして追加する</p>
                <button style={s.modalActionBtn} onClick={() => saveNewDeck(pendingFileName, pendingWords)}>
                  ✨ 新規デッキ 「{pendingFileName}」 を作成
                </button>
              </div>
              <div style={s.modalDivider}>または</div>
              <div style={s.modalSection}>
                <p style={s.modalLabel}>② 元あるデッキに追加（合流）する</p>
                <div style={s.modalDeckList}>
                  {decks.map((deck) => (
                    <button key={deck.id} style={s.modalDeckRowBtn} onClick={() => appendToExistingDeck(deck.id, pendingWords)}>
                      <span>{deck.name} に追加</span>
                      <span style={{fontSize: 11, opacity: 0.5}}>{deck.words.length}単語 ➔ {deck.words.length + pendingWords.length}単語へ</span>
                    </button>
                  ))}
                </div>
              </div>
              <button style={s.modalCancelBtn} onClick={closeImportModal}>キャンセル</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (screen === "result" && activeDeck) {
    const total = queue.length;
    const learnedPct = Math.round((learned.size / total) * 100) || 0;
    const notYetPct = Math.round((notYet.size / total) * 100) || 0;

    return (
      <div style={s.root}>
        <div style={s.blob1} /><div style={s.blob2} />
        <main style={s.main}>
          <div style={s.resultCard}>
            <span style={{fontSize: 48}}>🎉</span>
            <h2 style={s.resultTitle}>お疲れ様でした！</h2>
            <p style={s.resultSub}>すべてのカードのチェックが完了しました。</p>

            <div style={s.resultStatsBox}>
              <div style={s.resultStatLine}>
                <span style={{color: "#4ade80", fontWeight: 700}}>✓ 覚えた単語:</span>
                <span>{learned.size} / {total} ({learnedPct}%)</span>
              </div>
              <div style={s.resultStatLine}>
                <span style={{color: "#ff6b6b", fontWeight: 700}}>✕ まだの単語:</span>
                <span>{notYet.size} / {total} ({notYetPct}%)</span>
              </div>
            </div>

            <div style={{...s.progressBar, height: 12, marginTop: 10, marginBottom: 10}}>
              <div style={{ ...s.progressFill, width: `${learnedPct}%` }} />
              <div style={{ ...s.progressNotYetFill, left: `${learnedPct}%`, width: `${notYetPct}%` }} />
            </div>

            {notYet.size > 0 && (
              <button style={s.btnNotYetReview} onClick={reviewNotYet}>
                ✕ 「まだ」の {notYet.size}単語 だけを復習する
              </button>
            )}

            <div style={{display: "flex", gap: 12, width: "100%", marginTop: 10}}>
              <button style={{...s.btnSkip, flex: 1, padding: "12px 0"} } onClick={goHome}>デッキ一覧へ</button>
              <button style={{...s.btnLearned, flex: 1, padding: "12px 0"}} onClick={resetDeck}>最初からやり直す</button>
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (!activeDeck || queue.length === 0) return null;
  
  const safeCurrent = current >= queue.length ? queue.length - 1 : current;
  const currentWordIndex = queue[safeCurrent];
  const w = activeDeck.words[currentWordIndex];
  
  const totalWords = queue.length;
  const learnedWidth = (learned.size / totalWords) * 100;
  const notYetWidth = (notYet.size / totalWords) * 100;
  const currentProgressWidth = ((safeCurrent + 1) / totalWords) * 100;

  return (
    <div style={s.root}>
      <div style={s.blob1} /><div style={s.blob2} /><div style={s.blob3} />
      <main style={s.main}>

        <header style={s.header}>
          <button style={s.backBtn} onClick={goHome}>← デッキ一覧</button>
          <span style={s.deckTitle}>{activeDeck.name} {reverseMode && "🔄"}</span>
          <div style={s.statsRow}>
            <span style={s.statChip}><span style={s.statNum}>{learned.size}</span> 覚えた</span>
            <span style={s.statChip}><span style={s.statNum}>{notYet.size}</span> まだ</span>
            <button style={s.resetBtn} onClick={resetDeck} title="最初からやり直す">↻ 重置</button>
          </div>
        </header>

        <div style={s.progressWrap}>
          <div style={s.progressLabel}>
            <span style={s.progressCurrent}>{safeCurrent + 1}</span>
            <span style={s.progressTotal}> / {totalWords} 単語</span>
          </div>
          <div style={s.progressBar}>
            <div style={{ ...s.progressFill, width: `${learnedWidth}%` }} />
            <div style={{ ...s.progressNotYetFill, left: `${learnedWidth}%`, width: `${notYetWidth}%` }} />
            <div style={{ ...s.progressIndicator, width: `${currentProgressWidth}%` }} />
          </div>
          <div style={s.progressPct}>{Math.round(currentProgressWidth)}%</div>
        </div>

        <div style={s.cardScene} onClick={handleFlip}>
          <div style={{ ...s.cardInner, transform: flipped ? "rotateY(180deg)" : "rotateY(0deg)" }}>
            
            <div style={s.cardFace}>
              <div style={s.cardCorner}>{reverseMode ? "表 (クイズ)" : "表"}</div>
              <button style={s.editCardBtn} onClick={(e) => { e.stopPropagation(); setEditForm(w); }}>✏️</button>
              <div style={s.frontContent}>
                {reverseMode ? (
                  <p style={{...s.meaningText, fontSize: 32}}>{w.meaning}</p>
                ) : (
                  <>
                    <p style={s.pinyin}>{w.pinyin}</p>
                    <p style={s.wordText}>{w.word}</p>
                    <button style={s.speakerBtn} onClick={(e) => { e.stopPropagation(); speak(w.word); }} aria-label="発音"><SpeakerIcon /></button>
                  </>
                )}
              </div>
              <p style={s.cardHint}>クリックで裏返す</p>
            </div>

            <div style={{ ...s.cardFace, ...s.cardBack }}>
              <div style={s.cardCorner}>{reverseMode ? "裏 (答え)" : "裏"}</div>
              <button style={s.editCardBtn} onClick={(e) => { e.stopPropagation(); setEditForm(w); }}>✏️</button>
              <div style={s.backContent}>
                {reverseMode ? (
                  <>
                    <p style={{...s.pinyin, color: "rgba(255,255,255,0.6)"}}>{w.pinyin}</p>
                    <p style={{...s.wordText, fontSize: 56}}>{w.word}</p>
                    <button style={{...s.speakerBtn, marginTop: 4}} onClick={(e) => { e.stopPropagation(); speak(w.word); }} aria-label="発音"><SpeakerIcon /></button>
                    <p style={{...s.meaningLabel, marginTop: 10}}>意味</p>
                    <p style={{...s.meaningText, fontSize: 18, opacity: 0.7}}>{w.meaning}</p>
                  </>
                ) : (
                  <>
                    <p style={s.meaningLabel}>意味</p>
                    <p style={s.meaningText}>{w.meaning}</p>
                    <p style={s.backWord}>{w.word}</p>
                  </>
                )}
              </div>
              <p style={s.cardHint}>クリックで戻る</p>
            </div>

          </div>
        </div>

        <div style={s.btnRow}>
          <button style={s.btnNotYet} onClick={() => goNext("notYet")}><span>✕</span><span>まだ</span></button>
          <button style={s.btnSkip} onClick={() => goNext("skip")}>スキップ</button>
          <button style={s.btnLearned} onClick={() => goNext("learned")}><span>覚えた</span><span>✓</span></button>
        </div>

        <div style={s.navRow}>
          <button style={s.navBtn} onClick={goPrev} disabled={safeCurrent === 0}>← 前へ</button>
          <button style={{ ...s.navBtn, ...(randomMode ? s.navBtnActive : {}) }} onClick={toggleRandom}>{randomMode ? "⇄ ランダム中" : "⇄ ランダム"}</button>
          <button style={{ ...s.navBtn, ...(reverseMode ? s.navBtnReverseActive : {}) }} onClick={() => setReverseMode(!reverseMode)}>{reverseMode ? "🔄 逆再生中 (日➔中)" : "🔄 カード反転"}</button>
          <button style={s.navBtn} onClick={() => goNext("skip")} disabled={safeCurrent + 1 >= totalWords}>次へ →</button>
        </div>

        {/* 単語編集モーダル */}
        {editForm && (
          <div style={s.modalOverlay} onClick={() => setEditForm(null)}>
            <div style={s.modalCard} onClick={(e) => e.stopPropagation()}>
              <h3 style={s.modalTitle}>単語を編集</h3>
              <div style={s.editField}><label style={s.editLabel}>単語</label><input style={s.editInput} value={editForm.word} onChange={(e) => setEditForm({...editForm, word: e.target.value})} /></div>
              <div style={s.editField}><label style={s.editLabel}>ピンイン</label><input style={s.editInput} value={editForm.pinyin} onChange={(e) => setEditForm({...editForm, pinyin: e.target.value})} /></div>
              <div style={s.editField}><label style={s.editLabel}>意味</label><textarea style={{...s.editInput, height: 80, resize: "none"}} value={editForm.meaning} onChange={(e) => setEditForm({...editForm, meaning: e.target.value})} /></div>
              <div style={{display: "flex", gap: 10, marginTop: 10}}>
                <button style={{...s.modalCancelBtn, flex: 1}} onClick={() => setEditForm(null)}>キャンセル</button>
                <button style={{...s.modalActionBtn, flex: 1, background: "rgba(40,200,100,0.15)", borderColor: "rgba(40,200,100,0.4)", color: "#4ade80"}} onClick={saveWordEdit}>保存する</button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function SpeakerIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  );
}

const CARD_W = 420;
const CARD_H = 280;
const F = "'Noto Sans JP', sans-serif";
const FS = "'Noto Serif JP', serif";

const s: Record<string, React.CSSProperties> = {
  root: { minHeight: "100vh", background: "#0a0a14", fontFamily: F, display: "flex", alignItems: "center", justifyContent: "center", position: "relative", overflow: "hidden" },
  blob1: { position: "absolute", width: 600, height: 600, borderRadius: "50%", background: "radial-gradient(circle, rgba(220,60,60,0.18) 0%, transparent 70%)", top: -100, left: -150, pointerEvents: "none" },
  blob2: { position: "absolute", width: 500, height: 500, borderRadius: "50%", background: "radial-gradient(circle, rgba(80,80,220,0.15) 0%, transparent 70%)", bottom: -80, right: -100, pointerEvents: "none" },
  blob3: { position: "absolute", width: 300, height: 300, borderRadius: "50%", background: "radial-gradient(circle, rgba(200,150,30,0.10) 0%, transparent 70%)", top: "40%", left: "60%", pointerEvents: "none" },

  authMain: { position: "relative", zIndex: 1, width: "100%", maxWidth: 360, padding: "40px 20px", display: "flex", flexDirection: "column", gap: 20, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 24, boxShadow: "0 20px 50px rgba(0,0,0,0.5)" },
  authForm: { display: "flex", flexDirection: "column", gap: 12 },
  logoutBtn: { padding: "6px 12px", borderRadius: 8, background: "rgba(255,80,80,0.1)", border: "1px solid rgba(255,80,80,0.2)", color: "#ff6b6b", fontSize: 11, cursor: "pointer", fontFamily: F },

  homeMain: { position: "relative", zIndex: 1, width: "100%", maxWidth: 520, padding: "40px 20px", display: "flex", flexDirection: "column", gap: 24 },
  homeLogo: { display: "flex", alignItems: "center", gap: 16 },
  logoHan: { fontSize: 52, fontWeight: 700, color: "#e8353e", fontFamily: FS, lineHeight: 1, textShadow: "0 0 30px rgba(232,53,62,0.5)" },
  logoTitle: { margin: 0, fontSize: 22, color: "#fff", fontWeight: 700, letterSpacing: "0.05em" },
  logoSub: { margin: 0, fontSize: 12, color: "rgba(255,255,255,0.35)", letterSpacing: "0.1em" },

  dropZone: { border: "2px dashed rgba(255,255,255,0.12)", borderRadius: 16, padding: "24px 20px", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, cursor: "pointer", transition: "border-color 0.2s, background 0.2s", background: "rgba(255,255,255,0.02)" },
  dropZoneActive: { borderColor: "#e8353e", background: "rgba(232,53,62,0.08)" },
  dropText: { margin: 0, fontSize: 14, color: "rgba(255,255,255,0.6)", fontWeight: 600 },
  dropSub: { margin: 0, fontSize: 11, color: "rgba(255,255,255,0.25)" },

  emptyText: { textAlign: "center", color: "rgba(255,255,255,0.25)", fontSize: 13, margin: 0 },
  deckList: { display: "flex", flexDirection: "column", gap: 10 },
  deckCard: { background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 14, padding: "14px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, cursor: "default" },
  deckInfo: { flex: 1, cursor: "pointer" },
  deckName: { margin: 0, fontSize: 15, color: "#fff", fontWeight: 600 },
  deckMetaRow: { display: "flex", alignItems: "center", gap: 10, marginTop: 4 },
  deckCount: { fontSize: 11, color: "rgba(255,255,255,0.35)" },
  deckBadge: { fontSize: 11, padding: "2px 8px", borderRadius: 12, fontWeight: 500 },
  deckActions: { display: "flex", gap: 6 },
  deckBtn: { padding: "6px 12px", borderRadius: 8, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.10)", color: "rgba(255,255,255,0.6)", fontSize: 12, cursor: "pointer" },
  deckBtnDelete: { color: "rgba(255,80,80,0.7)", borderColor: "rgba(255,80,80,0.2)" },
  renameInput: { flex: 1, background: "rgba(255,255,255,0.08)", border: "1px solid rgba(232,53,62,0.5)", borderRadius: 8, padding: "6px 10px", color: "#fff", fontSize: 14, outline: "none", fontFamily: F },

  main: { position: "relative", zIndex: 1, width: "100%", maxWidth: 560, padding: "28px 20px", display: "flex", flexDirection: "column", alignItems: "center", gap: 20 },
  header: { width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 },
  backBtn: { background: "transparent", border: "none", color: "rgba(255,255,255,0.4)", fontSize: 12, cursor: "pointer", padding: "4px 0", whiteSpace: "nowrap", fontFamily: F },
  deckTitle: { fontSize: 14, color: "#fff", fontWeight: 700, letterSpacing: "0.05em", flex: 1, textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  statsRow: { display: "flex", gap: 6, alignItems: "center" },
  statChip: { background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.10)", borderRadius: 20, padding: "3px 10px", fontSize: 11, color: "rgba(255,255,255,0.5)", whiteSpace: "nowrap" },
  statNum: { color: "#fff", fontWeight: 700 },
  resetBtn: { background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 20, padding: "3px 10px", color: "rgba(255,255,255,0.5)", fontSize: 11, cursor: "pointer", fontFamily: F, transition: "background 0.2s" },

  progressWrap: { width: "100%", display: "flex", alignItems: "center", gap: 12 },
  progressLabel: { fontSize: 13, whiteSpace: "nowrap" },
  progressCurrent: { color: "#fff", fontWeight: 700, fontSize: 15 },
  progressTotal: { color: "rgba(255,255,255,0.4)" },
  progressBar: { flex: 1, height: 6, background: "rgba(255,255,255,0.06)", borderRadius: 3, overflow: "hidden", position: "relative" },
  progressFill: { height: "100%", background: "#4ade80", borderRadius: 3, transition: "width 0.4s ease", position: "absolute", top: 0, left: 0 },
  progressNotYetFill: { height: "100%", background: "#ff6b6b", transition: "width 0.4s ease, left 0.4s ease", position: "absolute", top: 0 },
  progressIndicator: { height: "100%", background: "rgba(255,255,255,0.15)", borderRight: "2px solid #fff", transition: "width 0.1s ease", position: "absolute", top: 0, left: 0, pointerEvents: "none" },
  progressPct: { fontSize: 12, color: "rgba(255,255,255,0.35)", whiteSpace: "nowrap", minWidth: 36, textAlign: "right" },

  cardScene: { width: CARD_W, height: CARD_H, perspective: 1000, cursor: "pointer", maxWidth: "100%" },
  cardInner: { width: "100%", height: "100%", position: "relative", transformStyle: "preserve-3d", transition: "transform 0.55s cubic-bezier(0.4,0,0.2,1)" },
  cardFace: { position: "absolute", width: "100%", height: "100%", backfaceVisibility: "hidden", WebkitBackfaceVisibility: "hidden", borderRadius: 20, background: "linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)", border: "1px solid rgba(255,255,255,0.10)", boxShadow: "0 25px 60px rgba(0,0,0,0.6)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 32, boxSizing: "border-box", userSelect: "none" },
  cardBack: { transform: "rotateY(180deg)", background: "linear-gradient(135deg, #1a0a0e 0%, #2d1117 50%, #4a0e1a 100%)" },
  cardCorner: { position: "absolute", top: 14, left: 18, fontSize: 10, color: "rgba(255,255,255,0.15)", letterSpacing: "0.1em" },
  editCardBtn: { position: "absolute", top: 14, right: 18, background: "rgba(255,255,255,0.1)", border: "none", borderRadius: "50%", width: 32, height: 32, color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, zIndex: 10 },
  frontContent: { display: "flex", flexDirection: "column", alignItems: "center", gap: 6, width: "100%", padding: "0 10px", boxSizing: "border-box" },
  pinyin: { margin: 0, fontSize: 16, color: "rgba(255,200,100,0.85)", letterSpacing: "0.12em", fontWeight: 400 },
  wordText: { margin: 0, fontSize: 64, color: "#fff", fontFamily: FS, fontWeight: 700, textShadow: "0 0 40px rgba(255,255,255,0.2)", lineHeight: 1 },
  speakerBtn: { marginTop: 10, background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 50, width: 38, height: 38, display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,200,100,0.9)", cursor: "pointer", padding: 0 },
  cardHint: { position: "absolute", bottom: 14, left: 0, right: 0, textAlign: "center", margin: 0, fontSize: 10, color: "rgba(255,255,255,0.18)", letterSpacing: "0.08em" },
  backContent: { display: "flex", flexDirection: "column", alignItems: "center", gap: 8, textAlign: "center", width: "100%", padding: "0 10px", boxSizing: "border-box" },
  meaningLabel: { margin: 0, fontSize: 10, color: "rgba(255,120,120,0.6)", letterSpacing: "0.15em", textTransform: "uppercase" },
  meaningText: { margin: 0, fontSize: 26, color: "#fff", fontFamily: FS, fontWeight: 500, lineHeight: 1.4 },
  backWord: { margin: 0, fontSize: 18, color: "rgba(255,120,120,0.5)", fontFamily: FS },

  btnRow: { display: "flex", gap: 12, width: "100%", maxWidth: CARD_W, justifyContent: "center" },
  btnNotYet: { flex: 1, padding: "14px 8px", borderRadius: 14, background: "rgba(232,53,62,0.12)", border: "1px solid rgba(232,53,62,0.35)", color: "#ff6b6b", fontSize: 14, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontFamily: F },
  btnSkip: { padding: "14px 16px", borderRadius: 14, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.10)", color: "rgba(255,255,255,0.4)", fontSize: 12, cursor: "pointer", fontFamily: F, whiteSpace: "nowrap" },
  btnLearned: { flex: 1, padding: "14px 8px", borderRadius: 14, background: "rgba(40,200,100,0.12)", border: "1px solid rgba(40,200,100,0.35)", color: "#4ade80", fontSize: 14, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontFamily: F },

  navRow: { display: "flex", gap: 8, justifyContent: "center", width: "100%", maxWidth: CARD_W + 40 },
  navBtn: { padding: "8px 12px", borderRadius: 10, background: "transparent", border: "1px solid rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.35)", fontSize: 11, cursor: "pointer", fontFamily: F, whiteSpace: "nowrap" },
  navBtnActive: { borderColor: "rgba(232,53,62,0.6)", color: "#ff6b6b", background: "rgba(232,53,62,0.10)" },
  navBtnReverseActive: { borderColor: "rgba(255,200,100,0.6)", color: "#ffb03a", background: "rgba(255,200,100,0.10)" },

  resultCard: { width: CARD_W, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 20, padding: 32, display: "flex", flexDirection: "column", alignItems: "center", gap: 16, boxSizing: "border-box", textAlign: "center" },
  resultTitle: { margin: 0, fontSize: 24, color: "#fff", fontWeight: 700 },
  resultSub: { margin: 0, fontSize: 14, color: "rgba(255,255,255,0.5)", lineHeight: 1.4 },
  resultStatsBox: { width: "100%", background: "rgba(0,0,0,0.2)", borderRadius: 12, padding: 16, display: "flex", flexDirection: "column", gap: 8, boxSizing: "border-box" },
  resultStatLine: { display: "flex", justifyContent: "space-between", fontSize: 14, color: "#fff" },
  btnNotYetReview: { width: "100%", padding: "14px", borderRadius: 14, background: "rgba(232,53,62,0.15)", border: "1px solid rgba(232,53,62,0.4)", color: "#ff6b6b", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: F, transition: "background 0.2s" },

  modalOverlay: { position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 20, backdropFilter: "blur(4px)" },
  modalCard: { background: "#16162a", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 24, width: "100%", maxWidth: 460, padding: 28, boxSizing: "border-box", display: "flex", flexDirection: "column", gap: 20, boxShadow: "0 30px 70px rgba(0,0,0,0.8)" },
  modalTitle: { margin: 0, fontSize: 18, color: "#fff", fontWeight: 700, textAlign: "center" },
  modalSub: { margin: 0, fontSize: 13, color: "rgba(255,255,255,0.5)", textAlign: "center", borderBottom: "1px solid rgba(255,255,255,0.08)", paddingBottom: 14 },
  modalSection: { display: "flex", flexDirection: "column", gap: 10 },
  modalLabel: { margin: 0, fontSize: 12, color: "rgba(255,255,255,0.4)", fontWeight: 600 },
  modalActionBtn: { width: "100%", padding: "12px", borderRadius: 12, background: "rgba(232,53,62,0.15)", border: "1px solid rgba(232,53,62,0.4)", color: "#ff6b6b", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: F, transition: "background 0.2s" },
  modalDivider: { textAlign: "center", fontSize: 12, color: "rgba(255,255,255,0.2)", position: "relative", display: "flex", alignItems: "center", justifyContent: "center" },
  modalDeckList: { display: "flex", flexDirection: "column", gap: 8, maxHeight: 180, overflowY: "auto", paddingRight: 4 },
  modalDeckRowBtn: { width: "100%", padding: "12px 16px", borderRadius: 12, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#fff", fontSize: 14, fontWeight: 500, cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", fontFamily: F, transition: "background 0.2s, border-color 0.2s" },
  modalCancelBtn: { width: "100%", padding: "10px", borderRadius: 12, background: "transparent", border: "1px solid rgba(255,255,255,0.15)", color: "rgba(255,255,255,0.5)", fontSize: 13, cursor: "pointer", fontFamily: F, marginTop: 6 },

  editField: { display: "flex", flexDirection: "column", gap: 6 },
  editLabel: { fontSize: 12, color: "rgba(255,255,255,0.6)" },
  editInput: { padding: "10px 12px", borderRadius: 8, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)", color: "#fff", fontSize: 14, fontFamily: F, outline: "none" }
};