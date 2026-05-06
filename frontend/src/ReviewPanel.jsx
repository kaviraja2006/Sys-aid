import { useState, useEffect } from 'react';
import { X } from 'lucide-react';

const getScoreColor = (score) => {
  if (score < 5) return 'bg-red-500';
  if (score < 7) return 'bg-yellow-500';
  return 'bg-green-500';
};

const getScoreLabel = (score) => {
  if (score < 5) return 'Needs Work';
  if (score < 7) return 'Good';
  return 'Excellent';
};

export default function ReviewPanel({ isOpen, scores, suggestions, feedback, onClose }) {
  if (!isOpen || !scores) {
    return null;
  }

  const scoreEntries = Object.entries(scores);
  const avgScore = Math.round(
    scoreEntries.reduce((sum, [_, score]) => sum + score, 0) / scoreEntries.length
  );

  return (
    <div className="fixed bottom-4 right-4 w-96 max-h-96 bg-[#050505] border border-[#1f2023] rounded-xl shadow-2xl z-40 flex flex-col overflow-hidden animate-in slide-in-from-bottom">
      {/* Header */}
      <div className="flex justify-between items-center p-4 border-b border-[#1f2023] bg-[#0c0d0f]">
        <h2 className="text-sm font-semibold text-gray-100">Architecture Review</h2>
        <button
          onClick={onClose}
          className="p-1 hover:bg-[#1f2023] rounded text-gray-400 hover:text-gray-200 transition-colors"
        >
          <X size={18} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto custom-scrollbar p-4 space-y-4">
        {/* Overall Score */}
        <div className="bg-[#1a1b1e] rounded-lg p-3 border border-[#2c2d31]">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-gray-400">OVERALL</span>
            <span className="text-lg font-bold text-gray-100">{avgScore}/10</span>
          </div>
          <div className="w-full bg-[#0c0d0f] rounded-full h-2 overflow-hidden">
            <div
              className={`h-full ${getScoreColor(avgScore)} transition-all`}
              style={{ width: `${(avgScore / 10) * 100}%` }}
            />
          </div>
          <p className="text-xs text-gray-400 mt-1">{getScoreLabel(avgScore)}</p>
        </div>

        {/* Individual Scores */}
        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-gray-400 uppercase mb-3">Scores</h3>
          {scoreEntries.map(([key, score]) => {
            const label = key
              .replace(/_/g, ' ')
              .split(' ')
              .map(w => w.charAt(0).toUpperCase() + w.slice(1))
              .join(' ');
            
            return (
              <div key={key}>
                <div className="flex justify-between items-center mb-1">
                  <span className="text-xs text-gray-300">{label}</span>
                  <span className="text-xs font-semibold text-gray-200">{score}/10</span>
                </div>
                <div className="w-full bg-[#1a1b1e] rounded-full h-2 overflow-hidden">
                  <div
                    className={`h-full ${getScoreColor(score)} transition-all`}
                    style={{ width: `${(score / 10) * 100}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>

        {/* Suggestions */}
        {suggestions && suggestions.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-xs font-semibold text-gray-400 uppercase mb-2">Suggestions</h3>
            <ul className="space-y-2">
              {suggestions.map((suggestion, idx) => (
                <li key={idx} className="flex gap-2 text-xs text-gray-300">
                  <span className="text-yellow-500 font-bold shrink-0">{idx + 1}.</span>
                  <span>{suggestion}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Feedback */}
        {feedback && (
          <div className="bg-[#1a1b1e] border border-[#2c2d31] rounded p-2 text-xs text-gray-300 leading-relaxed">
            <p className="font-medium text-gray-200 mb-1">Feedback</p>
            <p>{feedback}</p>
          </div>
        )}
      </div>
    </div>
  );
}
