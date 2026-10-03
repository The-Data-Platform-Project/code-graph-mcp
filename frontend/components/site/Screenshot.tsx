import Image from "next/image";

/** A real screenshot of the app, framed as a browser window. */
export default function Screenshot({
  src,
  alt,
  width,
  height,
  url = "contextforge.ai/graph",
  caption,
  priority,
}: {
  src: string;
  alt: string;
  width: number;
  height: number;
  url?: string;
  caption?: string;
  priority?: boolean;
}) {
  return (
    <figure style={{ margin: 0 }}>
      <div className="frame">
        <div className="frame-bar" aria-hidden="true">
          <span className="dot" /><span className="dot" /><span className="dot" />
          <span className="url">{url}</span>
        </div>
        <Image
          src={src}
          alt={alt}
          width={width}
          height={height}
          sizes="(max-width: 960px) 100vw, 1180px"
          priority={priority}
        />
      </div>
      {caption && <figcaption className="caption">{caption}</figcaption>}
    </figure>
  );
}
