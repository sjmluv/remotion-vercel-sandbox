import React from "react";
import {
  AbsoluteFill,
  OffthreadVideo,
  Sequence,
  useCurrentFrame,
  interpolate,
} from "remotion";

/**
 * Minimal example composition that plays a list of video clips
 * with a fade-in title overlay.
 *
 * This demonstrates that OffthreadVideo works correctly with
 * the patched GNU compositor in Vercel Sandbox.
 */
export const ExampleComposition: React.FC<{
  clipUrls: string[];
  title: string;
}> = ({ clipUrls, title }) => {
  const frame = useCurrentFrame();
  const titleOpacity = interpolate(frame, [0, 30, 90, 120], [0, 1, 1, 0], {
    extrapolateRight: "clamp",
  });

  const CLIP_DURATION = 120; // 4 seconds at 30fps

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {/* Video clips played in sequence */}
      {clipUrls.map((url, i) => (
        <Sequence key={i} from={i * CLIP_DURATION} durationInFrames={CLIP_DURATION}>
          <AbsoluteFill>
            <OffthreadVideo src={url} style={{ width: "100%", height: "100%" }} />
          </AbsoluteFill>
        </Sequence>
      ))}

      {/* Title overlay with fade animation */}
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          opacity: titleOpacity,
        }}
      >
        <h1
          style={{
            color: "white",
            fontSize: 64,
            fontFamily: "sans-serif",
            textShadow: "0 2px 20px rgba(0,0,0,0.8)",
            textAlign: "center",
            padding: "0 40px",
          }}
        >
          {title}
        </h1>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
