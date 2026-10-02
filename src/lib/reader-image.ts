// A complete image can also be a failed download. Older browsers lack decode,
// so test its dimensions and remove both event listeners after settling.
export function waitForReaderImage(image: HTMLImageElement): Promise<void> {
  if (typeof image.decode === "function") return image.decode();
  if (image.complete) {
    return image.naturalWidth > 0
      ? Promise.resolve()
      : Promise.reject(new Error("Image failed to load"));
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      image.removeEventListener("load", onLoad);
      image.removeEventListener("error", onError);
    };
    const onLoad = () => {
      cleanup();
      if (image.naturalWidth > 0) resolve();
      else reject(new Error("Image failed to load"));
    };
    const onError = () => {
      cleanup();
      reject(new Error("Image failed to load"));
    };
    image.addEventListener("load", onLoad);
    image.addEventListener("error", onError);
  });
}
