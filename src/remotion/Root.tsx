import React from "react";
import { Composition } from "remotion";
import { ExampleComposition } from "./Composition";

/**
 * Root component that registers all Remotion compositions.
 * Add your compositions here.
 */
export const Root: React.FC = () => {
  return (
    <>
      {/* Landscape (1920x1080) */}
      <Composition
        id="Example"
        component={ExampleComposition}
        durationInFrames={120}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{
          clipUrls: [],
          title: "Example Video",
        }}
      />

      {/* Portrait (1080x1920) */}
      <Composition
        id="Example-portrait"
        component={ExampleComposition}
        durationInFrames={120}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{
          clipUrls: [],
          title: "Example Video",
        }}
      />
    </>
  );
};
