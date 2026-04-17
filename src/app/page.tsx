"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Chess, Move, Square } from "chess.js";
import { io, Socket } from "socket.io-client";

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const RANKS = [8, 7, 6, 5, 4, 3, 2, 1];

const PIECES: Record<string, string> = {
  wp: "♙",
  wr: "♖",
  wn: "♘",
  wb: "♗",
  wq: "♕",
  wk: "♔",
  bp: "♟",
  br: "♜",
  bn: "♞",
  bb: "♝",
  bq: "♛",
  bk: "♚",
};

type GameMode = "versus" | "training";
type MatchResult = "white" | "black" | "draw";
type EntryMode = "computer" | "online";

type Player = {
  id: number;
  name: string;
  country: string;
  type: "human" | "computer";
  level: "easy" | "medium" | "hard" | null;
  rating: number;
};

type TrainingLevel = {
  key: "easy" | "medium" | "hard";
  label: string;
  estimatedRating: number;
};

type Match = {
  id: number;
  whitePlayerId: number;
  blackPlayerId: number;
  mode: GameMode;
  level: "easy" | "medium" | "hard" | null;
  result: "pending" | MatchResult;
  training?: {
    humanPlayerId: number;
    computerPlayerId: number;
    humanColor: "white" | "black";
  };
};

type Ranking = {
  rank: number;
  playerId: number;
  name: string;
  country: string;
  rating: number;
  type: "human" | "computer";
  level: "easy" | "medium" | "hard" | null;
  matchesPlayed: number;
};

type AuthUser = {
  id: number;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  player: {
    id: number;
    name: string;
    country: string;
    rating: number;
    type: "human" | "computer";
    level: "easy" | "medium" | "hard" | null;
  } | null;
};

type OnlineGame = {
  id: number;
  whitePlayerId: number;
  blackPlayerId: number | null;
  fen: string;
  turn: "w" | "b";
  status: "waiting" | "active" | "finished";
  winner: "white" | "black" | "draw" | null;
  pgn: string | null;
};

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4000/api";
const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || API_BASE_URL.replace(/\/api\/?$/, "");
const PIECE_VALUES: Record<string, number> = {
  p: 100,
  n: 320,
  b: 330,
  r: 500,
  q: 900,
  k: 20000,
};

function squareName(file: string, rank: number): Square {
  return `${file}${rank}` as Square;
}

function statusMessage(game: Chess): string {
  if (game.isCheckmate()) {
    const winner = game.turn() === "w" ? "Black" : "White";
    return `Checkmate. ${winner} wins.`;
  }
  if (game.isDraw()) {
    return "Draw.";
  }
  if (game.isCheck()) {
    return `${game.turn() === "w" ? "White" : "Black"} to move (in check).`;
  }
  return `${game.turn() === "w" ? "White" : "Black"} to move.`;
}

function evaluatePosition(game: Chess): number {
  const board = game.board();
  let score = 0;

  for (const row of board) {
    for (const piece of row) {
      if (!piece) {
        continue;
      }
      const value = PIECE_VALUES[piece.type] || 0;
      score += piece.color === "w" ? value : -value;
    }
  }

  return score;
}

function randomChoice<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function scoreCandidateMove(game: Chess, move: Move): number {
  const clone = new Chess(game.fen());
  clone.move(move);

  const evalScore = evaluatePosition(clone);
  const perspective = game.turn() === "w" ? evalScore : -evalScore;
  const captureBonus = move.captured ? (PIECE_VALUES[move.captured] || 0) * 0.4 : 0;
  const promotionBonus = move.promotion ? 300 : 0;
  const checkBonus = move.san.includes("+") ? 35 : 0;

  return perspective + captureBonus + promotionBonus + checkBonus;
}

function negamax(game: Chess, depth: number, alpha: number, beta: number, color: number): number {
  if (depth === 0 || game.isGameOver()) {
    return color * evaluatePosition(game);
  }

  let best = Number.NEGATIVE_INFINITY;
  const moves = game.moves({ verbose: true });

  for (const move of moves) {
    game.move(move);
    const score = -negamax(game, depth - 1, -beta, -alpha, -color);
    game.undo();

    if (score > best) {
      best = score;
    }
    if (best > alpha) {
      alpha = best;
    }
    if (alpha >= beta) {
      break;
    }
  }

  return best;
}

function chooseBotMove(game: Chess, level: "easy" | "medium" | "hard"): Move | null {
  const moves = game.moves({ verbose: true });
  if (moves.length === 0) {
    return null;
  }

  if (level === "easy") {
    return randomChoice(moves);
  }

  if (level === "medium") {
    const scored = moves
      .map((move) => ({ move, score: scoreCandidateMove(game, move) }))
      .sort((a, b) => b.score - a.score);
    const topChoices = scored.slice(0, Math.min(3, scored.length));
    return randomChoice(topChoices).move;
  }

  const depth = 3;
  const rootColor = game.turn() === "w" ? 1 : -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestMove = moves[0];

  for (const move of moves) {
    game.move(move);
    const score = -negamax(game, depth - 1, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, -rootColor);
    game.undo();
    if (score > bestScore) {
      bestScore = score;
      bestMove = move;
    }
  }

  return bestMove;
}

export default function Home() {
  const [entryMode, setEntryMode] = useState<EntryMode | null>(null);
  const [fen, setFen] = useState(new Chess().fen());
  const [selectedSquare, setSelectedSquare] = useState<Square | null>(null);
  const [legalTargets, setLegalTargets] = useState<Square[]>([]);
  const [moveHistory, setMoveHistory] = useState<string[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [rankings, setRankings] = useState<Ranking[]>([]);
  const [trainingLevels, setTrainingLevels] = useState<TrainingLevel[]>([]);
  const [activeMatch, setActiveMatch] = useState<Match | null>(null);
  const [mode, setMode] = useState<GameMode>("versus");
  const [selectedHumanId, setSelectedHumanId] = useState<number | null>(null);
  const [selectedTrainingLevel, setSelectedTrainingLevel] = useState<"easy" | "medium" | "hard">("easy");
  const [humanColor, setHumanColor] = useState<"white" | "black">("white");
  const [loading, setLoading] = useState(false);
  const [isSubmittingResult, setIsSubmittingResult] = useState(false);
  const [message, setMessage] = useState<string>("");
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [onlineGame, setOnlineGame] = useState<OnlineGame | null>(null);
  const [onlineJoinId, setOnlineJoinId] = useState("");
  const [onlineColor, setOnlineColor] = useState<"white" | "black" | null>(null);
  const socketRef = useRef<Socket | null>(null);

  const game = useMemo(() => new Chess(fen), [fen]);
  const humanPlayers = useMemo(() => players.filter((player) => player.type === "human"), [players]);

  const inferBoardResult = (): MatchResult | null => {
    if (game.isCheckmate()) {
      return game.turn() === "w" ? "black" : "white";
    }
    if (game.isDraw()) {
      return "draw";
    }
    return null;
  };

  const autoDetectedResult = inferBoardResult();

  const activeTraining = activeMatch?.mode === "training" ? activeMatch : null;
  const trainingHumanColor: "white" | "black" | null =
    activeTraining?.training?.humanColor ||
    (selectedHumanId && activeTraining
      ? activeTraining.whitePlayerId === selectedHumanId
        ? "white"
        : activeTraining.blackPlayerId === selectedHumanId
          ? "black"
          : null
      : null);
  const sideToMove: "white" | "black" = game.turn() === "w" ? "white" : "black";
  const isHumanTurn = !activeTraining || trainingHumanColor === sideToMove;
  const authPlayerId = authUser?.player?.id ?? null;
  const isAuthenticated = Boolean(authUser);
  const isOnlineMode = entryMode === "online";
  const isOnlineTurn = onlineColor ? sideToMove === onlineColor : false;

  const getHistoryFromPgn = (pgn: string | null): string[] => {
    if (!pgn) {
      return [];
    }
    const parser = new Chess();
    try {
      parser.loadPgn(pgn);
      return parser.history();
    } catch {
      return [];
    }
  };

  const resolveOnlineColor = (gameState: OnlineGame): "white" | "black" | null => {
    if (!authPlayerId) {
      return null;
    }
    if (gameState.whitePlayerId === authPlayerId) {
      return "white";
    }
    if (gameState.blackPlayerId === authPlayerId) {
      return "black";
    }
    return null;
  };

  const getPlayerName = (id: number) => {
    const player = players.find((entry) => entry.id === id);
    if (!player) {
      return `Player #${id}`;
    }
    return player.name;
  };

  async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
      cache: "no-store",
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({ message: "Request failed" }));
      throw new Error(payload.message || "Request failed");
    }

    return response.json();
  }

  const refreshPlayers = async () => {
    const payload = await apiFetch<{ players: Player[] }>("/players");
    setPlayers(payload.players);
    setSelectedHumanId((current) => {
      if (current) {
        return current;
      }
      const defaultHuman = payload.players.find((player) => player.type === "human");
      return defaultHuman?.id || null;
    });
  };

  const refreshRankings = async () => {
    const payload = await apiFetch<{ rankings: Ranking[] }>("/rankings/mondial");
    setRankings(payload.rankings);
  };

  useEffect(() => {
    let cancelled = false;

    const bootstrap = async () => {
      try {
        const [statusPayload, mePayload] = await Promise.all([
          apiFetch<{ enabled: boolean }>("/auth/status"),
          apiFetch<{ authenticated: boolean; user: AuthUser | null }>("/auth/me"),
        ]);

        if (cancelled) {
          return;
        }

        const queryParams = new URLSearchParams(window.location.search);
        const authFlag = queryParams.get("auth");
        if (authFlag === "failed") {
          setMessage("Google sign-in failed. Please try again.");
        }
        if (authFlag) {
          window.history.replaceState({}, "", window.location.pathname);
        }

        setAuthEnabled(statusPayload.enabled);
        const user = mePayload.authenticated ? mePayload.user : null;
        setAuthUser(user);

        if (!user) {
          setPlayers([]);
          setRankings([]);
          setTrainingLevels([]);
          setSelectedHumanId(null);
          return;
        }

        const [playersPayload, rankingsPayload, levelsPayload] = await Promise.all([
          apiFetch<{ players: Player[] }>("/players"),
          apiFetch<{ rankings: Ranking[] }>("/rankings/mondial"),
          apiFetch<{ levels: TrainingLevel[] }>("/training/levels"),
        ]);

        if (cancelled) {
          return;
        }

        setPlayers(playersPayload.players);
        setRankings(rankingsPayload.rankings);
        setTrainingLevels(levelsPayload.levels);
        setSelectedHumanId(user.player?.id || null);
      } catch (error) {
        if (!cancelled) {
          setMessage(`Failed to load app data: ${(error as Error).message}`);
        }
      } finally {
        if (!cancelled) {
          setIsBootstrapping(false);
        }
      }
    };

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!activeTraining || activeTraining.result !== "pending") {
      return;
    }
    if (!activeTraining.level) {
      return;
    }
    if (game.isGameOver() || isHumanTurn) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const nextGame = new Chess(fen);
      const botMove = chooseBotMove(nextGame, activeTraining.level as "easy" | "medium" | "hard");
      if (botMove) {
        nextGame.move(botMove);
        setFen(nextGame.fen());
        setMoveHistory((prev) => [...prev, botMove.san]);
      }
    }, 420);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [activeTraining, fen, game, isHumanTurn]);

  useEffect(() => {
    if (!isAuthenticated || !isOnlineMode) {
      return;
    }

    const socket = io(SOCKET_URL, {
      withCredentials: true,
      transports: ["websocket", "polling"],
    });

    socketRef.current = socket;

    socket.on("online-game:joined", (payload: { game: OnlineGame; yourColor: "white" | "black" }) => {
      setOnlineGame(payload.game);
      setOnlineColor(payload.yourColor);
      setFen(payload.game.fen);
      setMoveHistory(getHistoryFromPgn(payload.game.pgn));
      setMessage(`Joined online game #${payload.game.id} as ${payload.yourColor}.`);
    });

    socket.on("online-game:update", (payload: { game: OnlineGame }) => {
      setOnlineGame(payload.game);
      setFen(payload.game.fen);
      setMoveHistory(getHistoryFromPgn(payload.game.pgn));
      if (payload.game.status === "finished") {
        setMessage(`Online game finished: ${payload.game.winner || "draw"}`);
        void apiFetch<{ rankings: Ranking[] }>("/rankings/mondial").then((data) => {
          setRankings(data.rankings);
        });
      }
    });

    socket.on("online-game:error", (payload: { message: string }) => {
      setMessage(payload.message);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [isAuthenticated, isOnlineMode]);

  const handleSquareClick = (square: Square) => {
    if (game.isGameOver()) {
      return;
    }

    if (isOnlineMode) {
      if (!onlineGame) {
        setMessage("Create or join an online game first.");
        return;
      }
      if (onlineGame.status !== "active") {
        setMessage("Waiting for opponent to join online game.");
        return;
      }
      if (!onlineColor) {
        setMessage("You are not assigned to a side in this game.");
        return;
      }
      if (!isOnlineTurn) {
        setMessage("It is not your turn.");
        return;
      }
    }

    if (activeTraining && !isHumanTurn) {
      setMessage("Computer is thinking...");
      return;
    }

    if (selectedSquare && legalTargets.includes(square)) {
      const nextGame = new Chess(fen);
      const move = nextGame.move({
        from: selectedSquare,
        to: square,
        promotion: "q",
      });

      if (move) {
        if (isOnlineMode && onlineGame) {
          socketRef.current?.emit("online-game:move", {
            gameId: onlineGame.id,
            from: selectedSquare,
            to: square,
            promotion: "q",
          });
        } else {
          setFen(nextGame.fen());
          setMoveHistory((prev) => [...prev, move.san]);
        }
      }

      setSelectedSquare(null);
      setLegalTargets([]);
      return;
    }

    const clickedPiece = game.get(square);
    if (!clickedPiece || clickedPiece.color !== game.turn()) {
      setSelectedSquare(null);
      setLegalTargets([]);
      return;
    }

    const moves = game.moves({ square, verbose: true });
    setSelectedSquare(square);
    setLegalTargets(moves.map((move) => move.to));
  };

  const resetBoard = () => {
    const freshGame = new Chess();
    setFen(freshGame.fen());
    setSelectedSquare(null);
    setLegalTargets([]);
    setMoveHistory([]);
  };

  const resetForNewMatch = () => {
    resetBoard();
    setMessage("");
  };

  const openModeSelection = () => {
    setEntryMode(null);
    setActiveMatch(null);
    setOnlineGame(null);
    setOnlineColor(null);
    setOnlineJoinId("");
    resetForNewMatch();
  };

  const selectEntryMode = (nextEntryMode: EntryMode) => {
    setEntryMode(nextEntryMode);
    setMode(nextEntryMode === "computer" ? "training" : "versus");
    setActiveMatch(null);
    setOnlineGame(null);
    setOnlineColor(null);
    setOnlineJoinId("");
    resetForNewMatch();
  };

  const createOnlineGameSession = async () => {
    try {
      setLoading(true);
      resetForNewMatch();
      const payload = await apiFetch<{ game: OnlineGame }>("/online-games", { method: "POST" });
      setOnlineGame(payload.game);
      setOnlineColor(resolveOnlineColor(payload.game));
      setFen(payload.game.fen);
      setMoveHistory(getHistoryFromPgn(payload.game.pgn));
      socketRef.current?.emit("online-game:join", { gameId: payload.game.id });
      setMessage(`Online game created: #${payload.game.id}. Share this ID with your opponent.`);
    } catch (error) {
      setMessage(`Failed to create online game: ${(error as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  const joinOnlineGameSession = async () => {
    const gameId = Number(onlineJoinId);
    if (!gameId) {
      setMessage("Enter a valid online game ID.");
      return;
    }

    try {
      setLoading(true);
      resetForNewMatch();
      await apiFetch<{ game: OnlineGame }>(`/online-games/${gameId}/join`, { method: "POST" });
      socketRef.current?.emit("online-game:join", { gameId });
      setMessage(`Joining online game #${gameId}...`);
    } catch (error) {
      setMessage(`Failed to join online game: ${(error as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  const findMatchOnlineSession = async () => {
    try {
      setLoading(true);
      resetForNewMatch();
      const payload = await apiFetch<{ game: OnlineGame; status: "queued" | "matched" }>(
        "/online-games/find-match",
        { method: "POST" },
      );

      setOnlineGame(payload.game);
      setOnlineColor(resolveOnlineColor(payload.game));
      setFen(payload.game.fen);
      setMoveHistory(getHistoryFromPgn(payload.game.pgn));
      socketRef.current?.emit("online-game:join", { gameId: payload.game.id });

      if (payload.status === "queued") {
        setMessage(`Queued for match. Waiting in game #${payload.game.id} for an opponent.`);
      } else {
        setMessage(`Match found. Joined game #${payload.game.id}.`);
      }
    } catch (error) {
      setMessage(`Failed to find match: ${(error as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  const startRandomMatch = async () => {
    if (entryMode === "online" && authEnabled && !isAuthenticated) {
      setMessage("Please sign in first to play online.");
      return;
    }

    try {
      setLoading(true);
      resetForNewMatch();
      const payload = await apiFetch<{ match: Match }>("/matches/random", { method: "POST" });
      setActiveMatch(payload.match);
      await Promise.all([refreshPlayers(), refreshRankings()]);
      setMessage(`Random match started: #${payload.match.id}`);
    } catch (error) {
      setMessage(`Failed to start random match: ${(error as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  const startTrainingMatch = async () => {
    const targetHumanId = authPlayerId || selectedHumanId;
    if (!targetHumanId) {
      setMessage("Select a human player first.");
      return;
    }

    try {
      setLoading(true);
      resetForNewMatch();
      const payload = await apiFetch<{ match: Match }>("/training/matches", {
        method: "POST",
        body: JSON.stringify({
          humanPlayerId: targetHumanId,
          level: selectedTrainingLevel,
          humanColor,
        }),
      });
      setActiveMatch(payload.match);
      await Promise.all([refreshPlayers(), refreshRankings()]);
      setMessage(`Training match started: #${payload.match.id} (${selectedTrainingLevel})`);
    } catch (error) {
      setMessage(`Failed to start training match: ${(error as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  const submitResult = async (result: MatchResult) => {
    if (!activeMatch || activeMatch.result !== "pending") {
      setMessage("Start a new match before submitting result.");
      return;
    }

    try {
      setIsSubmittingResult(true);
      const endpoint =
        activeMatch.mode === "training"
          ? `/training/matches/${activeMatch.id}/result`
          : `/matches/${activeMatch.id}/result`;

      const payload = await apiFetch<{ match: Match }>(endpoint, {
        method: "POST",
        body: JSON.stringify({
          result,
          pgn: moveHistory.join(" "),
        }),
      });

      setActiveMatch(payload.match);
      await Promise.all([refreshPlayers(), refreshRankings()]);
      setMessage(`Match #${payload.match.id} result submitted: ${result.toUpperCase()}`);
    } catch (error) {
      setMessage(`Failed to submit result: ${(error as Error).message}`);
    } finally {
      setIsSubmittingResult(false);
    }
  };

  const handleGoogleLogin = () => {
    if (!authEnabled) {
      setMessage("Google OAuth is not configured yet on backend. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in backend .env.");
      return;
    }
    window.location.href = `${API_BASE_URL}/auth/google`;
  };

  const handleLogout = async () => {
    try {
      await apiFetch<{ success: boolean }>("/auth/logout", { method: "POST" });
      setAuthUser(null);
      setEntryMode(null);
      setActiveMatch(null);
      setOnlineGame(null);
      setOnlineColor(null);
      setOnlineJoinId("");
      setPlayers([]);
      setRankings([]);
      setTrainingLevels([]);
      setSelectedHumanId(null);
      setMessage("Logged out successfully.");
    } catch (error) {
      setMessage(`Logout failed: ${(error as Error).message}`);
    }
  };

  if (isBootstrapping) {
    return (
      <div className="min-h-screen bg-[radial-gradient(circle_at_top,#f6d7a7_0%,#f2c38b_40%,#efe7cf_100%)] px-4 py-10 text-stone-900">
        <main className="mx-auto max-w-2xl rounded-[2rem] border border-amber-900/20 bg-white/70 p-8 text-center shadow-[0_30px_80px_rgba(96,66,20,0.2)] backdrop-blur">
          <p className="text-sm uppercase tracking-[0.16em] text-amber-800">Loading</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight">Preparing Chess Arena</h1>
        </main>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-[radial-gradient(circle_at_top,#f6d7a7_0%,#f2c38b_40%,#efe7cf_100%)] px-4 py-10 text-stone-900">
        <main className="mx-auto max-w-3xl rounded-[2rem] border border-amber-900/20 bg-white/70 p-8 shadow-[0_30px_80px_rgba(96,66,20,0.2)] backdrop-blur md:p-10">
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-amber-800">Account Access</p>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight">Login or Sign Up</h1>
          <p className="mt-3 text-sm text-stone-700">
            Sign in with Google to create your real player account, then continue to Choose Your Chess Arena.
          </p>

          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={handleGoogleLogin}
              className="rounded-full bg-blue-700 px-5 py-2.5 text-sm font-medium text-blue-50 transition hover:bg-blue-800"
            >
              Login with Google
            </button>
            <button
              type="button"
              onClick={handleGoogleLogin}
              className="rounded-full bg-emerald-700 px-5 py-2.5 text-sm font-medium text-emerald-50 transition hover:bg-emerald-800"
            >
              Sign Up with Google
            </button>
          </div>

          {message && <p className="mt-4 text-sm font-medium text-red-700">{message}</p>}
          {!authEnabled && (
            <p className="mt-2 text-xs text-stone-600">
              OAuth is currently not configured on backend. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_CALLBACK_URL in backend .env.
            </p>
          )}
        </main>
      </div>
    );
  }

  if (!entryMode) {
    return (
      <div className="min-h-screen bg-[radial-gradient(circle_at_top,#f6d7a7_0%,#f2c38b_40%,#efe7cf_100%)] px-4 py-10 text-stone-900">
        <main className="mx-auto max-w-5xl rounded-[2rem] border border-amber-900/20 bg-white/70 p-6 shadow-[0_30px_80px_rgba(96,66,20,0.2)] backdrop-blur md:p-10">
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-amber-800">Welcome</p>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight">Choose Your Chess Arena</h1>
          <p className="mt-3 max-w-2xl text-sm text-stone-700">
            Select how you want to play. You can switch mode later from inside the game.
          </p>

          <div className="mt-8 grid gap-4 md:grid-cols-2">
            <button
              type="button"
              onClick={() => selectEntryMode("computer")}
              className="group relative overflow-hidden rounded-3xl border border-emerald-900/20 bg-emerald-50/70 p-6 text-left transition duration-300 hover:-translate-y-1 hover:shadow-xl"
            >
              <div className="absolute -right-10 -top-10 h-24 w-24 rounded-full bg-emerald-300/35 transition duration-300 group-hover:scale-125" />
              <div className="absolute -left-6 -bottom-6 h-16 w-16 rounded-full border-4 border-emerald-400/30" />
              <div className="relative z-10 inline-flex h-10 w-10 items-center justify-center rounded-full bg-emerald-800 text-sm font-bold text-emerald-50">AI</div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">Training Mode</p>
              <h2 className="mt-2 text-2xl font-semibold text-emerald-950">Play Against Computer</h2>
              <p className="mt-2 text-sm text-emerald-900/80">
                Choose Easy, Medium, or Hard AI and play with automatic bot responses.
              </p>
              <span className="mt-4 inline-block rounded-full bg-emerald-800 px-3 py-1 text-xs font-medium text-emerald-50">
                Start vs Computer
              </span>
            </button>

            <button
              type="button"
              onClick={() => selectEntryMode("online")}
              className="group relative overflow-hidden rounded-3xl border border-sky-900/20 bg-sky-50/70 p-6 text-left transition duration-300 hover:-translate-y-1 hover:shadow-xl"
            >
              <div className="absolute -right-8 -top-8 h-20 w-20 rounded-full bg-sky-300/35 transition duration-300 group-hover:scale-125" />
              <div className="absolute -left-4 -bottom-4 h-14 w-14 rounded-full border-4 border-sky-400/30" />
              <div className="relative z-10 inline-flex h-10 w-10 items-center justify-center rounded-full bg-sky-800 text-xs font-bold text-sky-50">WWW</div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-sky-700">Online Mode</p>
              <h2 className="mt-2 text-2xl font-semibold text-sky-950">Play Online Match</h2>
              <p className="mt-2 text-sm text-sky-900/80">
                Start a backend random match and submit result to update the mondial ranking.
              </p>
              {authEnabled && !authUser && (
                <p className="mt-2 text-xs font-medium text-red-700">Sign in required for online mode.</p>
              )}
              <span className="mt-4 inline-block rounded-full bg-sky-800 px-3 py-1 text-xs font-medium text-sky-50">
                Start Online
              </span>
            </button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,#ffe8b8_0%,#ffd8a8_35%,#f8f0dc_100%)] px-4 py-8 text-stone-900">
      <main className="mx-auto grid w-full max-w-7xl gap-6 lg:grid-cols-[minmax(320px,620px)_1fr]">
        <section className="rounded-3xl border border-amber-900/20 bg-white/70 p-4 shadow-[0_20px_70px_rgba(96,66,20,0.2)] backdrop-blur">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Chess Arena</h1>
              <p className="text-sm text-stone-700">Connected to backend matches, training, and rankings</p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleLogout}
                className="rounded-full bg-stone-700 px-4 py-2 text-sm font-medium text-stone-50 transition hover:bg-stone-800"
              >
                Log out
              </button>
              <button
                type="button"
                onClick={openModeSelection}
                className="rounded-full bg-stone-800 px-4 py-2 text-sm font-medium text-stone-50 transition hover:bg-stone-900"
              >
                Change Mode
              </button>
              <button
                type="button"
                onClick={resetBoard}
                className="rounded-full bg-amber-800 px-4 py-2 text-sm font-medium text-amber-50 transition hover:bg-amber-900"
              >
                Reset Board
              </button>
            </div>
          </div>

          <div className="mb-4 rounded-2xl border border-amber-900/20 bg-amber-50/70 p-3">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-800">
              {entryMode === "computer" ? "Current Mode: Against Computer" : "Current Mode: Online"}
            </p>

            {mode === "training" && (
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                <select
                  value={selectedHumanId ?? ""}
                  onChange={(event) => setSelectedHumanId(Number(event.target.value))}
                  className="rounded-lg border border-amber-900/20 bg-white px-2 py-2 text-sm"
                >
                  {humanPlayers.map((player) => (
                    <option key={player.id} value={player.id}>
                      {player.name} ({player.rating})
                    </option>
                  ))}
                </select>
                <select
                  value={selectedTrainingLevel}
                  onChange={(event) =>
                    setSelectedTrainingLevel(event.target.value as "easy" | "medium" | "hard")
                  }
                  className="rounded-lg border border-amber-900/20 bg-white px-2 py-2 text-sm"
                >
                  {trainingLevels.map((level) => (
                    <option key={level.key} value={level.key}>
                      {level.label} ({level.estimatedRating})
                    </option>
                  ))}
                </select>
                <select
                  value={humanColor}
                  onChange={(event) => setHumanColor(event.target.value as "white" | "black")}
                  className="rounded-lg border border-amber-900/20 bg-white px-2 py-2 text-sm"
                >
                  <option value="white">Human as White</option>
                  <option value="black">Human as Black</option>
                </select>
              </div>
            )}

            {isOnlineMode && (
              <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
                <input
                  type="text"
                  value={onlineJoinId}
                  onChange={(event) => setOnlineJoinId(event.target.value)}
                  placeholder="Enter game ID to join"
                  className="rounded-lg border border-amber-900/20 bg-white px-2 py-2 text-sm"
                />
                <button
                  type="button"
                  disabled={loading}
                  onClick={joinOnlineGameSession}
                  className="rounded-full bg-sky-700 px-4 py-2 text-sm font-medium text-sky-50 disabled:opacity-60"
                >
                  Join Game
                </button>
              </div>
            )}

            <div className="mt-3 flex flex-wrap gap-2">
              {isOnlineMode ? (
                <>
                  <button
                    type="button"
                    disabled={loading}
                    onClick={findMatchOnlineSession}
                    className="rounded-full bg-violet-700 px-4 py-2 text-sm font-medium text-violet-50 disabled:opacity-60"
                  >
                    {loading ? "Searching..." : "Find Match"}
                  </button>
                  <button
                    type="button"
                    disabled={loading}
                    onClick={createOnlineGameSession}
                    className="rounded-full bg-emerald-700 px-4 py-2 text-sm font-medium text-emerald-50 disabled:opacity-60"
                  >
                    {loading ? "Starting..." : "Create Online Game"}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={loading}
                  onClick={mode === "versus" ? startRandomMatch : startTrainingMatch}
                  className="rounded-full bg-emerald-700 px-4 py-2 text-sm font-medium text-emerald-50 disabled:opacity-60"
                >
                  {loading ? "Starting..." : mode === "versus" ? "Start Random Match" : "Start Training Match"}
                </button>
              )}
            </div>

            <div className="mt-3 text-sm text-stone-700">
              {isOnlineMode ? (
                <>
                  <p>{onlineGame ? `Online game #${onlineGame.id} (${onlineGame.status})` : "No online game joined"}</p>
                  {onlineGame && (
                    <p>
                      White: {getPlayerName(onlineGame.whitePlayerId)} | Black: {onlineGame.blackPlayerId ? getPlayerName(onlineGame.blackPlayerId) : "Waiting..."}
                    </p>
                  )}
                  {onlineGame && (
                    <p>
                      Your side: {onlineColor || "spectator"} | Turn: {sideToMove}
                    </p>
                  )}
                </>
              ) : (
                <p>{activeMatch ? `Active match #${activeMatch.id} (${activeMatch.mode})` : "No active backend match"}</p>
              )}
              {activeMatch && !isOnlineMode && (
                <p>
                  White: {getPlayerName(activeMatch.whitePlayerId)} | Black: {getPlayerName(activeMatch.blackPlayerId)}
                </p>
              )}
              {activeTraining && (
                <p>
                  Training level: {activeTraining.level} | Human: {trainingHumanColor || "unknown"} | {isHumanTurn ? "Your turn" : "Bot thinking..."}
                </p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-8 overflow-hidden rounded-2xl border-4 border-amber-950/80 shadow-lg">
            {RANKS.map((rank) =>
              FILES.map((file) => {
                const square = squareName(file, rank);
                const piece = game.get(square);
                const isLight = (rank + FILES.indexOf(file)) % 2 === 0;
                const isSelected = selectedSquare === square;
                const isTarget = legalTargets.includes(square);

                return (
                  <button
                    key={square}
                    type="button"
                    onClick={() => handleSquareClick(square)}
                    className={`relative aspect-square w-full text-3xl transition sm:text-4xl ${
                      isLight ? "bg-[#f7ecd0]" : "bg-[#7f5f3c]"
                    } ${isSelected ? "ring-4 ring-sky-500 ring-inset" : ""}`}
                  >
                    {piece ? PIECES[`${piece.color}${piece.type}`] : ""}
                    {isTarget && (
                      <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                        <span className="h-3 w-3 rounded-full bg-sky-500/80" />
                      </span>
                    )}
                    {(rank === 1 || file === "a") && (
                      <span className="pointer-events-none absolute text-[10px] font-semibold text-stone-900/70">
                        {file === "a" && <span className="left-1 top-1 absolute">{rank}</span>}
                        {rank === 1 && <span className="right-1 bottom-1 absolute">{file}</span>}
                      </span>
                    )}
                  </button>
                );
              }),
            )}
          </div>
        </section>

        <aside className="rounded-3xl border border-amber-900/20 bg-white/70 p-5 shadow-[0_20px_70px_rgba(96,66,20,0.16)] backdrop-blur">
          <h2 className="text-xl font-semibold">Game Status</h2>
          <p className="mt-2 text-sm text-stone-700">{statusMessage(game)}</p>

          {isOnlineMode ? (
            <div className="mt-4 rounded-xl border border-sky-900/20 bg-sky-50/60 p-3 text-sm text-sky-900">
              <p className="font-semibold">Online Match</p>
              <p className="mt-1 text-xs">Moves are validated by server socket. Result updates automatically when checkmate/draw is reached.</p>
              {message && <p className="mt-3 text-xs font-medium text-stone-800">{message}</p>}
            </div>
          ) : (
            <div className="mt-4 rounded-xl border border-sky-900/20 bg-sky-50/60 p-3 text-sm text-sky-900">
              <p className="font-semibold">Submit Match Result</p>
              <p className="mt-1 text-xs">
                After finishing the game on board, submit the final result to update mondial ranking.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={isSubmittingResult}
                  onClick={() => submitResult("white")}
                  className="rounded-full bg-zinc-900 px-3 py-1.5 text-xs text-white disabled:opacity-50"
                >
                  White Won
                </button>
                <button
                  type="button"
                  disabled={isSubmittingResult}
                  onClick={() => submitResult("black")}
                  className="rounded-full bg-zinc-900 px-3 py-1.5 text-xs text-white disabled:opacity-50"
                >
                  Black Won
                </button>
                <button
                  type="button"
                  disabled={isSubmittingResult}
                  onClick={() => submitResult("draw")}
                  className="rounded-full bg-zinc-900 px-3 py-1.5 text-xs text-white disabled:opacity-50"
                >
                  Draw
                </button>
                {autoDetectedResult && (
                  <button
                    type="button"
                    disabled={isSubmittingResult}
                    onClick={() => submitResult(autoDetectedResult)}
                    className="rounded-full bg-sky-700 px-3 py-1.5 text-xs text-sky-50 disabled:opacity-50"
                  >
                    Auto: {autoDetectedResult}
                  </button>
                )}
              </div>
              {message && <p className="mt-3 text-xs font-medium text-stone-800">{message}</p>}
            </div>
          )}

          <div className="mt-6 rounded-2xl bg-stone-900/95 p-4 text-stone-100">
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-amber-300">Move list</h3>
            {moveHistory.length === 0 ? (
              <p className="text-sm text-stone-300">No moves yet.</p>
            ) : (
              <ol className="grid max-h-[28rem] grid-cols-2 gap-x-6 gap-y-1 overflow-auto text-sm">
                {moveHistory.map((move, index) => (
                  <li key={`${move}-${index}`}>{`${index + 1}. ${move}`}</li>
                ))}
              </ol>
            )}
          </div>

          <div className="mt-6 rounded-2xl border border-amber-900/20 bg-white p-4">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-amber-900">Mondial Leaderboard</h3>
            <div className="mt-3 max-h-80 overflow-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="text-stone-500">
                    <th className="py-1">#</th>
                    <th className="py-1">Player</th>
                    <th className="py-1">Rating</th>
                    <th className="py-1">Played</th>
                  </tr>
                </thead>
                <tbody>
                  {rankings.map((entry) => (
                    <tr key={entry.playerId} className="border-t border-stone-200/80 text-stone-800">
                      <td className="py-1">{entry.rank}</td>
                      <td className="py-1">
                        {entry.name}
                        {entry.type === "computer" && entry.level ? ` (bot ${entry.level})` : ""}
                      </td>
                      <td className="py-1 font-semibold">{entry.rating}</td>
                      <td className="py-1">{entry.matchesPlayed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </aside>
      </main>
    </div>
  );
}
