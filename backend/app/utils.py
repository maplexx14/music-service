import io
from PIL import Image
import asyncio

def _compress_image_sync(image_bytes: bytes, max_size: tuple[int, int] = (800, 800), quality: int = 80, format: str = "WEBP") -> bytes:
    """
    Synchronously compress an image using Pillow.
    Resize if larger than max_size and reduce quality.
    """
    try:
        img = Image.open(io.BytesIO(image_bytes))
        
        # Convert to RGB if needed (e.g., if RGBA or P)
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")
            
        # Resize maintaining aspect ratio
        img.thumbnail(max_size, Image.Resampling.LANCZOS)
        
        # Save to bytes
        output = io.BytesIO()
        img.save(output, format=format, optimize=True, quality=quality)
        return output.getvalue()
    except Exception as e:
        # If anything fails, return original bytes (or surface error)
        print(f"Failed to compress image: {e}")
        return image_bytes

async def compress_image(image_bytes: bytes, max_size: tuple[int, int] = (800, 800), quality: int = 80, format: str = "WEBP") -> bytes:
    """
    Asynchronously compress an image by offloading to a thread.
    """
    return await asyncio.to_thread(_compress_image_sync, image_bytes, max_size, quality, format)
