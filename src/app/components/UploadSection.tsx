import { useState, useRef, useCallback } from "react";

interface Props {
  onUploaded: () => void;
}

type UploadState = "idle" | "uploading" | "done" | "error";

export function UploadSection({ onUploaded }: Props) {
  const [state, setState] = useState<UploadState>("idle");
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const uploadFile = useCallback(
    async (file: File) => {
      if (
        !file.type.startsWith("video/") &&
        !file.name.match(/\.(mp4|mov|mkv|avi|webm)$/i)
      ) {
        setState("error");
        setMessage("Unsupported file type. Use MP4, MOV, MKV, AVI, or WebM.");
        return;
      }

      setState("uploading");
      setProgress(0);
      setMessage(`Uploading ${file.name}…`);

      const formData = new FormData();
      formData.append("video", file);

      return new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/upload");

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable)
            setProgress(Math.round((e.loaded / e.total) * 100));
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            setState("done");
            setMessage("Uploaded — pipeline is processing…");
            setProgress(100);
            onUploaded();
            setTimeout(() => {
              setState("idle");
              setProgress(0);
              setMessage("");
            }, 4000);
            resolve();
          } else {
            setState("error");
            setMessage(`Upload failed (${xhr.status}): ${xhr.responseText}`);
            reject(new Error(xhr.responseText));
          }
        };

        xhr.onerror = () => {
          setState("error");
          setMessage("Network error during upload.");
          reject(new Error("Network error"));
        };

        xhr.send(formData);
      });
    },
    [onUploaded],
  );

  const handleFiles = (files: FileList | null) => {
    if (!files?.length) return;
    const file = files[0];
    if (file) void uploadFile(file);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    handleFiles(e.dataTransfer.files);
  };

  const isUploading = state === "uploading";

  return (
    <div>
      <div
        className={`upload-zone${dragOver ? " drag-over" : ""}`}
        onClick={() => !isUploading && inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <div className="icon">
          {state === "done" ? "✅" : state === "error" ? "❌" : "🎬"}
        </div>
        <div className="label">
          {isUploading ? "Uploading…" : "Drop a video file or click to browse"}
        </div>
        <div className="hint">MP4 · MOV · MKV · AVI · WebM · up to 10 GB</div>
        <input
          ref={inputRef}
          type="file"
          accept="video/mp4,video/quicktime,video/x-matroska,video/x-msvideo,video/webm,.mp4,.mov,.mkv,.avi,.webm"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>

      {(isUploading || state === "done") && (
        <div className="upload-progress">
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${progress}%` }} />
          </div>
          <div className="progress-label">{message}</div>
        </div>
      )}

      {state === "error" && (
        <div className="upload-progress">
          <div className="progress-label" style={{ color: "var(--red)" }}>
            {message}
          </div>
        </div>
      )}
    </div>
  );
}
