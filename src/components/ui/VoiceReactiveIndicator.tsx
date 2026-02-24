import React from "react";

interface VoiceReactiveIndicatorProps {
  audioLevel: number; // 0-1 normalized audio level
  barCount?: number;
  baseHeight?: number;
  maxHeight?: number;
}

export const VoiceReactiveIndicator: React.FC<VoiceReactiveIndicatorProps> = ({
  audioLevel,
  barCount = 3,
  baseHeight = 4,
  maxHeight = 14,
}) => {
  // Create variation for each bar based on position
  const getBarHeight = (index: number) => {
    // Middle bar(s) react more, outer bars react less
    const middleIndex = (barCount - 1) / 2;
    const distanceFromMiddle = Math.abs(index - middleIndex);
    const reactivity = 1 - (distanceFromMiddle / barCount) * 0.5;

    // Add slight randomness for organic feel
    const noise = Math.sin(Date.now() / 100 + index * 50) * 0.1;

    const level = Math.min(1, audioLevel * reactivity + noise * audioLevel);
    return baseHeight + level * (maxHeight - baseHeight);
  };

  return (
    <div style={{ display: "flex", alignItems: "center", height: maxHeight, gap: 2 }}>
      {[...Array(barCount)].map((_, i) => (
        <div
          key={i}
          className="bg-primary-foreground"
          style={{
            width: 4,
            height: getBarHeight(i),
            borderRadius: "var(--radius-sm)",
            opacity: "var(--opacity-high)",
            transition: "height 0.05s ease-out",
          }}
        />
      ))}
    </div>
  );
};
