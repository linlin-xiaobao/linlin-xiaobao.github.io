import React, { useState, useEffect } from 'react';
import ARGame from './components/ARGame';
import { generateSound } from './utils/sound';

enum GameState {
  MENU,
  PLAYING,
  GAME_OVER
}

export default function App() {
  const [gameState, setGameState] = useState<GameState>(GameState.MENU);
  const [score, setScore] = useState(0);
  const [message, setMessage] = useState('');

  const startGame = () => {
    generateSound('ui');
    setScore(0);
    setGameState(GameState.PLAYING);
  };

  const endGame = (finalScore: number) => {
    setScore(finalScore);
    setGameState(GameState.GAME_OVER);
  };

  return (
    <div className="relative w-full h-full text-white font-val overflow-hidden">
      {/* Game Layer */}
      <ARGame 
        gameState={gameState} 
        onScoreUpdate={setScore} 
        onGameOver={endGame}
      />

      {/* UI Overlay */}
      <div id="ui-layer" className="flex flex-col justify-between p-6">
        
        {/* Header HUD */}
        <div className="flex justify-between items-start w-full">
          <div className="flex flex-col">
            <h1 className="text-3xl md:text-5xl font-bold tracking-wider text-[#ff4655] drop-shadow-md uppercase">
              无畏契约
            </h1>
            <span className="text-xl md:text-2xl text-white tracking-widest opacity-80">
              小琳特供版
            </span>
          </div>
          
          {gameState === GameState.PLAYING && (
            <div className="flex flex-col items-end">
              <span className="text-sm text-gray-400 tracking-widest">KILLS</span>
              <span className="text-6xl font-bold text-white drop-shadow-[0_0_10px_rgba(255,70,85,0.5)]">
                {score}
              </span>
            </div>
          )}
        </div>

        {/* Center Menus */}
        <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-full max-w-md text-center pointer-events-auto">
          
          {gameState === GameState.MENU && (
            <div className="bg-[#0f1923]/90 border border-[#ff4655] p-8 backdrop-blur-md animate-fade-in">
              <p className="text-gray-300 mb-6 text-lg">
                Use your hand as a pistol.<br/>
                <span className="text-[#ff4655]">Index finger</span> to aim.<br/>
                <span className="text-[#ff4655]">Thumb</span> to shoot.
              </p>
              <button 
                onClick={startGame}
                className="bg-[#ff4655] hover:bg-[#d93442] text-white text-2xl font-bold py-3 px-12 clip-path-polygon transition-all duration-200 active:scale-95"
                style={{ clipPath: 'polygon(10% 0, 100% 0, 100% 70%, 90% 100%, 0 100%, 0 30%)' }}
              >
                START MISSION
              </button>
            </div>
          )}

          {gameState === GameState.GAME_OVER && (
            <div className="bg-[#0f1923]/90 border border-[#ff4655] p-8 backdrop-blur-md animate-fade-in">
              <h2 className="text-5xl font-bold text-white mb-2 uppercase">Mission Over</h2>
              <div className="w-full h-px bg-gray-600 my-4"></div>
              <div className="flex justify-between items-center mb-8 px-4">
                <span className="text-gray-400 text-xl">FINAL SCORE</span>
                <span className="text-[#ff4655] text-4xl font-bold">{score}</span>
              </div>
              <button 
                onClick={startGame}
                className="bg-white hover:bg-gray-200 text-[#0f1923] text-2xl font-bold py-3 px-12 transition-all duration-200 active:scale-95"
                style={{ clipPath: 'polygon(10% 0, 100% 0, 100% 70%, 90% 100%, 0 100%, 0 30%)' }}
              >
                PLAY AGAIN
              </button>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="text-center text-xs text-gray-500 opacity-50">
          AR GESTURE SYSTEM ONLINE • V 1.0
        </div>
      </div>
    </div>
  );
}