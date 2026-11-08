from pathlib import Path
import sys

sys.path.insert(0, r'C:\Users\maplex\.codex\tmp\ios-retouch-packages')
import cv2
import numpy as np

directory = Path(__file__).resolve().parent
filename = directory / 'ios-notification-edited-v4.png'
original = cv2.imdecode(np.fromfile(filename, dtype=np.uint8), cv2.IMREAD_COLOR)
gray = cv2.cvtColor(original, cv2.COLOR_BGR2GRAY)
background = cv2.medianBlur(gray, 21)
contrast = gray.astype(np.int16) - background.astype(np.int16)
label = np.zeros(gray.shape, dtype=np.uint8)
region = np.s_[836:885, 25:446]
label[region] = ((original[region].min(axis=2) > 184) & (contrast[region] > 9)).astype(np.uint8) * 255
for name, algorithm, dilation, radius in [('v4', cv2.INPAINT_NS, 7, 4), ('v4-telea', cv2.INPAINT_TELEA, 7, 4), ('v4-fine', cv2.INPAINT_TELEA, 3, 3), ('v4-medium', cv2.INPAINT_TELEA, 5, 3)]:
    mask = cv2.dilate(label, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (dilation, dilation)))
    cv2.circle(mask, (550, 857), 28, 255, -1)
    restored = cv2.inpaint(original, mask, radius, algorithm)
    outside_changes = np.count_nonzero(np.any(restored != original, axis=2) & (mask == 0))
    assert outside_changes == 0
    target = directory / f'ios-notification-edited-{name}.png'
    cv2.imencode('.png', restored)[1].tofile(target)
    cv2.imencode('.png', restored[814:1054])[1].tofile(directory / f'notification-detail-{name}.png')
    print(f'{name}: {np.count_nonzero(mask)} retouched pixels, {outside_changes} changes outside mask')
cv2.imencode('.png', mask[814:1054])[1].tofile(directory / 'notification-removal-mask.png')
