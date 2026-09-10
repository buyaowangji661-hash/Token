"""生成 Token 的托盘/应用图标（assets/icon.png + assets/icon.ico）。"""
from PIL import Image, ImageDraw

SIZE = 256
BRAND = (77, 107, 254, 255)
BG = (24, 26, 38, 0)

img = Image.new("RGBA", (SIZE, SIZE), BG)
draw = ImageDraw.Draw(img)
radius = 56
draw.rounded_rectangle((8, 8, SIZE - 8, SIZE - 8), radius=radius, fill=BRAND)

# 白色的 "T"
bar_w = 26
top = 62
bar_left = 58
bar_right = SIZE - 58
draw.rounded_rectangle((bar_left, top, bar_right, top + bar_w), radius=13, fill=(255, 255, 255, 255))
stem_w = 30
stem_x = SIZE // 2
draw.rounded_rectangle(
    (stem_x - stem_w // 2, top, stem_x + stem_w // 2, 196), radius=15, fill=(255, 255, 255, 255)
)
draw.ellipse((stem_x - 20, 176, stem_x + 20, 216), fill=(255, 255, 255, 255))

img.save(r"D:/Token/assets/icon.png")
sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
img.save(r"D:/Token/assets/icon.ico", sizes=sizes)
print("icon written")
