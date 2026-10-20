# Filter Reference

85 filters in 17 categories (generated from `src/shared/filters.ts`).

## Load

_Loads image and video files._

| Filter | Description | Parameters (defaults) |
|---|---|---|
| **Image Loader** | Loads an image from file. | File: — |
| **Video Loader** | Loads image and video files. | File: —<br>Video Engine: WebCodecs (frame accurate)<br>Color Range: From File<br>Color Matrix: From File<br>Chroma Filter: Bicubic (highest quality)<br>Chroma Siting: From File<br>HDR Video: Tone map to SDR (BT.2390)<br>HDR Peak (cd/m²) (200–10000): 1000 |
| **Sequence Loader** | Loads a sequence of images as a video. | Files: —<br>Frame Rate (0.1–240): 25.000 |
| **Test Pattern** | Generates synthetic test material to validate the processing. | Pattern: License Plate (degraded)<br>Width (64–3840): 640<br>Height (64–2160): 360<br>Frames (1–10000): 60<br>Frame Rate (1–120): 25.00<br>Motion Blur (0–40): 9.0<br>Blur Angle (-90–90): 12<br>Noise (0–60): 10.0<br>Camera Shake (0–30): 4.0<br>Seed (0–9999): 7 |

## Link

_Combines the outputs of different chains._

| Filter | Description | Parameters (defaults) |
|---|---|---|
| **Video Mixer** | Mixes the current chain with another chain. | Second Input: —<br>Mode: Blend<br>Balance (0–1): 0.5000<br>Gain (1–20): 1.0<br>Frame Offset (-1000–1000): 0<br>Checker Size (4–256): 32 |
| **Multiview** | Shows several chains at the same time in a grid. | Chains: —<br>Columns (0 = auto) (0–8): 0<br>Show Labels: Yes<br>Border (0–20): 2<br>Border Color: #202020 |
| **Picture In Picture** | Inserts the output of another chain as an inset. | Inset Chain: —<br>Position X (%) (0–100): 70.0<br>Position Y (%) (0–100): 5.0<br>Scale (%) (5–100): 25.0<br>Border (0–20): 2<br>Border Color: #ffffff<br>Frame Offset (-1000–1000): 0 |
| **Timeline** | Concatenates other chains after the current one. | Append Chains: — |

## Write

_Writes the processed images and videos to file._

| Filter | Description | Parameters (defaults) |
|---|---|---|
| **Video Writer** | Writes the processed video to file. | Format: AVI (uncompressed)<br>Quality (lossy only) (0.1–1): 0.92<br>Frame Rate (0 = input) (0–240): 0.000<br>Frames: All Frames<br>File Name: output |
| **Image Writer** | Writes the processed frames as images. | Format: TIFF 16-bit (uncompressed)<br>Quality (lossy only) (0.1–1): 0.95<br>Frames: Current Frame<br>File Name: frame |

## Select Frames

_Selects a subset of the frames of the video._

| Filter | Description | Parameters (defaults) |
|---|---|---|
| **Single Selector** | Selects a single frame of the video. | Frame: 0 |
| **Range Selector** | Selects a range of frames of the video. | First Frame: 0<br>Last Frame (-1 = end): Last<br>Step (1–1000): 1 |
| **Sparse Selector** | Selects a list of frames of the video. | Frames: 0 |
| **Remove Duplicates** | Removes duplicated frames (typical of CCTV recordings at variable frame rate). | Threshold (0–50): 0.50<br>Region (optional): — |
| **Frame Type Selector** | Selects frames by their compression type (I, P, B). | I Frames: Yes<br>P Frames: No<br>B Frames: No |
| **Demultiplexer** | Automatically selects similar frames (to discard bad frames or separate multiplexed cameras) with the ability to set a similarity threshold and a reference frame. | Reference Frame: 0<br>Similarity Threshold (0–100): 75.0<br>Region (optional): — |
| **Motion Detection** | Selects the frames with motion in a region. | Region: —<br>Pixel Threshold (1–128): 20<br>Minimum Area (%) (0–100): 0.50<br>Keep: Frames With Motion |

## Deinterlacing

_Processes the interlaced videos._

| Filter | Description | Parameters (defaults) |
|---|---|---|
| **Deinterlace** | Removes the interlacing artifacts.<br><sub>Ref.: G. de Haan, E.B. Bellers, "Deinterlacing — An overview", Proceedings of the IEEE 86(9), 1998.</sub> | Field: Top (Even)<br>Method: Linear Interpolation |
| **Line Doubling** | Keeps one field and doubles its lines.<br><sub>Ref.: G. de Haan, E.B. Bellers, "Deinterlacing — An overview", Proceedings of the IEEE 86(9), 1998.</sub> | Field: Top (Even) |
| **Field Separation** | Separates the two fields of each frame. | Mode: Stacked (Top/Bottom) |
| **Field Shift** | Shifts one field to correct misaligned interlaced recordings. | Field: Bottom (Odd)<br>Shift X (-64–64): 0<br>Shift Y (-8–8): 0 |
| **Interleave** | Interleaves pairs of consecutive frames as the two fields of a frame. | First Frame As: Top Field |

## Edit

_Geometric transformations and corrections._

| Filter | Description | Parameters (defaults) |
|---|---|---|
| **Crop** | Crops a region of the image. | Region: — |
| **Resize** | Changes the size of the image.<br><sub>Ref.: R. Keys, "Cubic convolution interpolation for digital image processing", IEEE Trans. ASSP 29(6), 1981; C.E. Duchon, "Lanczos filtering in one and two dimensions", J. Applied Meteorology 18, 1979.</sub> | Mode: Scale Factor<br>Scale (%) (1–1600): 200.0<br>Width (1–16384): 1280<br>Height (1–16384): 720<br>Keep Aspect Ratio: Yes<br>Interpolation: Bicubic |
| **Rotate** | Rotates the image.<br><sub>Ref.: R. Keys, "Cubic convolution interpolation for digital image processing", IEEE Trans. ASSP 29(6), 1981; C.E. Duchon, "Lanczos filtering in one and two dimensions", J. Applied Meteorology 18, 1979.</sub> | Angle (-180–180): 0.00<br>Interpolation: Bicubic<br>Expand Canvas: Yes<br>Background: #000000 |
| **Flip** | Flips the image horizontally or vertically. | Horizontal: Yes<br>Vertical: No |
| **Correct Perspective** | Rectifies a planar surface seen in perspective (e.g. a license plate or a document).<br><sub>Ref.: R. Hartley, A. Zisserman, "Multiple View Geometry in Computer Vision", 2nd ed., Cambridge University Press, 2004.</sub> | Corners: —<br>Output Width (0 = auto) (0–8192): 0<br>Output Height (0 = auto) (0–8192): 0<br>Interpolation: Bicubic |
| **Correct Lens Distortion** | Corrects the radial (barrel or pincushion) distortion of wide angle lenses.<br><sub>Ref.: D.C. Brown, "Decentering distortion of lenses", Photogrammetric Engineering 32(3), 1966.</sub> | Radial k1 (-1–1): 0.0000<br>Radial k2 (-1–1): 0.0000<br>Center X (0–1): 0.500<br>Center Y (0–1): 0.500<br>Zoom (0.2–3): 1.000<br>Interpolation: Bicubic |
| **Correct Aspect Ratio** | Corrects non-square pixels (e.g. 704x576 PAL or 720x480 NTSC recordings).<br><sub>Ref.: R. Keys, "Cubic convolution interpolation for digital image processing", IEEE Trans. ASSP 29(6), 1981; C.E. Duchon, "Lanczos filtering in one and two dimensions", J. Applied Meteorology 18, 1979.</sub> | Pixel Aspect Ratio: From Source<br>Custom PAR (0.25–4): 1.0000<br>Adjust: Width<br>Interpolation: Bicubic |

## Channels

_Color conversion and extraction functions._

| Filter | Description | Parameters (defaults) |
|---|---|---|
| **Grayscale Conversion** | Converts the image to grayscale.<br><sub>Ref.: ITU-R Recommendation BT.601-7 (2011) and BT.709-6 (2015); CIE 15:2004 Colorimetry.</sub> | Method: Luma BT.601 |
| **Color Conversion** | Converts the image to another color space and shows its channels as RGB.<br><sub>Ref.: ITU-R Recommendation BT.601-7 (2011) and BT.709-6 (2015); CIE 15:2004 Colorimetry.</sub> | Color Space: YCbCr (BT.601) |
| **Color Switch** | Swaps the color channels. | R Output: Blue<br>G Output: Green<br>B Output: Red |
| **Extract Channel** | Extracts a single channel as a grayscale image.<br><sub>Ref.: ITU-R Recommendation BT.601-7 (2011) and BT.709-6 (2015); CIE 15:2004 Colorimetry.</sub> | Channel: Luma (Y)<br>Stretch Values: No |
| **Enable Channels** | Enables or disables the single channels. | Red: Yes<br>Green: Yes<br>Blue: Yes |
| **Replace Channel** | Replaces a channel with a channel of another chain. | Target Channel: Red<br>Source Chain: —<br>Source Channel: Luma |

## Adjust

_Brightness, contrast, levels and color adjustments._

| Filter | Description | Parameters (defaults) |
|---|---|---|
| **Levels** | Adjusts the input and output levels of the image.<br><sub>Ref.: R.C. Gonzalez, R.E. Woods, "Digital Image Processing", 4th ed., Pearson, 2018.</sub> | Channel: All<br>Input Black (0–255): 0.0<br>Input White (0–255): 255.0<br>Gamma (0.1–10): 1.000<br>Output Black (0–255): 0.0<br>Output White (0–255): 255.0 |
| **Curves** | Adjusts the tonal range with a curve.<br><sub>Ref.: R.C. Gonzalez, R.E. Woods, "Digital Image Processing", 4th ed., Pearson, 2018.</sub> | Channel: All<br>Curve: 0→0, 255→255 |
| **Brightness/Contrast** | Adjusts the brightness and the contrast. | Brightness (-255–255): 0.0<br>Contrast (-100–100): 0.0 |
| **Exposure/Gamma** | Adjusts exposure, gamma and offset. | Exposure (stops) (-5–5): 0.00<br>Gamma (0.1–5): 1.000<br>Offset (-128–128): 0.0 |
| **Auto Contrast** | Stretches the histogram automatically for each frame.<br><sub>Ref.: R.C. Gonzalez, R.E. Woods, "Digital Image Processing", 4th ed., Pearson, 2018.</sub> | Clip Shadows (%) (0–20): 0.50<br>Clip Highlights (%) (0–20): 0.50<br>Link Channels: Yes |
| **Histogram Equalization** | Equalizes the histogram globally or locally (CLAHE).<br><sub>Ref.: K. Zuiderveld, "Contrast Limited Adaptive Histogram Equalization", Graphics Gems IV, Academic Press, 1994.</sub> | Mode: Local (CLAHE)<br>Tiles (2–32): 8<br>Clip Limit (1–20): 3.0<br>Apply To: Luminance<br>Amount (0–1): 1.00 |
| **Color Balance** | Corrects color casts manually, automatically or from a neutral reference.<br><sub>Ref.: G. Buchsbaum, "A spatial processor model for object colour perception", Journal of the Franklin Institute 310(1), 1980.</sub> | Mode: Gray World<br>Red Gain (0–4): 1.000<br>Green Gain (0–4): 1.000<br>Blue Gain (0–4): 1.000<br>Reference Point: —<br>Sample Radius (0–20): 3 |
| **Hue/Saturation** | Adjusts hue, saturation and lightness. | Hue (-180–180): 0.0<br>Saturation (-100–100): 0.0<br>Lightness (-100–100): 0.0 |
| **Negative** | Inverts the values of the image. | — |
| **Threshold** | Converts the image to black and white. | Level (0–255): 128.0<br>Mode: Luminance |

## Extract

_Extracts information not visible in the original data._

| Filter | Description | Parameters (defaults) |
|---|---|---|
| **Fourier** | Shows the Fourier spectrum of the image.<br><sub>Ref.: J.W. Cooley, J.W. Tukey, "An algorithm for the machine calculation of complex Fourier series", Mathematics of Computation 19, 1965.</sub> | Show: Magnitude<br>Logarithmic: Yes<br>Channel: Luminance |
| **Fourier Filter** | Removes periodic noise or applies low/high pass filters in the frequency domain.<br><sub>Ref.: J.W. Cooley, J.W. Tukey, "An algorithm for the machine calculation of complex Fourier series", Mathematics of Computation 19, 1965.</sub> | View: Spectrum<br>Filter: Notch Reject<br>Notches: —<br>Notch Radius (1–64): 8.0<br>Symmetric Notches: Yes<br>Cutoff (0.005–0.5): 0.100<br>Smooth Transition: Yes |
| **Edge Detection** | Computes the gradient (edges) of the image.<br><sub>Ref.: I. Sobel, G. Feldman, "A 3x3 isotropic gradient operator for image processing", Stanford AI Project, 1968; H. Scharr, PhD thesis, Heidelberg University, 2000.</sub> | Operator: Sobel<br>Output: Magnitude<br>Gain (0.1–20): 1.00 |
| **Frame Difference** | Shows the difference between each frame and a previous one. | Frame Offset (1–100): 1<br>Gain (1–20): 4.0<br>Mode: Absolute |
| **Bit Plane** | Shows a single bit plane of a channel (hidden information, compression traces).<br><sub>Ref.: R.C. Gonzalez, R.E. Woods, "Digital Image Processing", 4th ed., Pearson, 2018.</sub> | Channel: Luma<br>Bit (0–7): 0 |

## Verify

_Compares and verifies processing results._

| Filter | Description | Parameters (defaults) |
|---|---|---|
| **Compare Original** | Compares the processed image with the original. | Mode: Side-by-Side Horizontally<br>Balance (0–1): 0.5000<br>Gain (1–5): 1.00<br>Line Color: #c0c0c0<br>Line Thickness (0–20): 0<br>Original First (Left/Top): Yes |
| **Error Level Analysis** | Highlights areas with a different JPEG compression level.<br><sub>Ref.: N. Krawetz, "A Picture's Worth: Digital Image Analysis and Forensics", Black Hat Briefings, 2007.</sub> | JPEG Quality (50–100): 90<br>Chroma Subsampling: 4:2:0 (most cameras)<br>Scale (1–60): 15.0 |

## Measure

_Measures distances on images._

| Filter | Description | Parameters (defaults) |
|---|---|---|
| **Measure 1D** | Measures a length using a reference of known length on the same line.<br><sub>Ref.: A. Criminisi, I. Reid, A. Zisserman, "Single View Metrology", International Journal of Computer Vision 40(2), 2000.</sub> | Reference Segment: —<br>Reference Length (0.001–100000): 1.000<br>Unit: m<br>Measured Segment: —<br>Color: #ffd400<br>Label Size (8–72): 16 |
| **Measure 2D** | Measures distances on a plane calibrated with a rectangle of known size.<br><sub>Ref.: A. Criminisi, I. Reid, A. Zisserman, "Single View Metrology", International Journal of Computer Vision 40(2), 2000.</sub> | Reference Rectangle: —<br>Rectangle Width (0.001–100000): 0.520<br>Rectangle Height (0.001–100000): 0.110<br>Unit: m<br>Measured Segment: —<br>Color: #00e0ff<br>Label Size (8–72): 16 |

## Sharpen

_Enhances the details of the image._

| Filter | Description | Parameters (defaults) |
|---|---|---|
| **Unsharp Masking** | Sharpens the image by adding the difference with a blurred version.<br><sub>Ref.: R.C. Gonzalez, R.E. Woods, "Digital Image Processing", 4th ed., Pearson, 2018.</sub> | Radius (0.3–20): 1.50<br>Amount (0–5): 1.00<br>Threshold (0–50): 0.0 |
| **Laplacian Sharpening** | Sharpens the image with a Laplacian filter.<br><sub>Ref.: R.C. Gonzalez, R.E. Woods, "Digital Image Processing", 4th ed., Pearson, 2018.</sub> | Amount (0–5): 1.00<br>Include Diagonals: Yes |
| **High Pass Sharpening** | Enhances local contrast with a large radius high pass filter.<br><sub>Ref.: R.C. Gonzalez, R.E. Woods, "Digital Image Processing", 4th ed., Pearson, 2018.</sub> | Radius (2–100): 20.0<br>Amount (0–3): 0.50 |

## Denoise

_Reduces the noise of the image._

| Filter | Description | Parameters (defaults) |
|---|---|---|
| **Averaging Filter** | Reduces the noise by averaging neighboring pixels.<br><sub>Ref.: R.C. Gonzalez, R.E. Woods, "Digital Image Processing", 4th ed., Pearson, 2018.</sub> | Radius (1–20): 1 |
| **Gaussian Filter** | Reduces the noise with a Gaussian blur.<br><sub>Ref.: R.C. Gonzalez, R.E. Woods, "Digital Image Processing", 4th ed., Pearson, 2018.</sub> | Sigma (0.3–30): 1.00 |
| **Median Filter** | Reduces impulsive (salt and pepper) noise preserving edges.<br><sub>Ref.: T.S. Huang, G.J. Yang, G.Y. Tang, "A fast two-dimensional median filtering algorithm", IEEE Trans. ASSP 27(1), 1979.</sub> | Radius (1–7): 1 |
| **Bilateral Filter** | Reduces the noise preserving the edges.<br><sub>Ref.: C. Tomasi, R. Manduchi, "Bilateral filtering for gray and color images", Proc. ICCV, 1998.</sub> | Spatial Sigma (0.5–8): 2.00<br>Range Sigma (1–100): 20.0 |
| **Non-Local Means** ⏱ | Advanced denoising comparing patches in a search window.<br><sub>Ref.: A. Buades, B. Coll, J.-M. Morel, "A non-local algorithm for image denoising", Proc. CVPR, 2005.</sub> | Strength (1–50): 10.0<br>Patch Radius (1–3): 1<br>Search Radius (2–10): 5 |
| **Wiener Filter** | Adaptive filter based on local statistics.<br><sub>Ref.: J.S. Lim, "Two-Dimensional Signal and Image Processing", Prentice Hall, 1990, p. 548 (adaptive Wiener filter).</sub> | Radius (1–6): 2<br>Noise Variance (0 = auto) (0–2000): 0.0 |
| **Deblocking** | Reduces the blocking artifacts of JPEG and MPEG compression.<br><sub>Ref.: P. List, A. Joch, J. Lainema, G. Bjontegaard, M. Karczewicz, "Adaptive deblocking filter", IEEE Trans. CSVT 13(7), 2003.</sub> | Block Size (4–32): 8<br>Strength (0–1): 0.60<br>Edge Threshold (1–80): 24.0 |

## Deblurring

_Corrects motion and optical blur._

| Filter | Description | Parameters (defaults) |
|---|---|---|
| **Motion Deblurring** | Corrects a linear motion blur.<br><sub>Ref.: N. Wiener, "Extrapolation, Interpolation, and Smoothing of Stationary Time Series", MIT Press, 1949; R.C. Gonzalez, R.E. Woods, "Digital Image Processing", ch. 5. W.H. Richardson, "Bayesian-Based Iterative Method of Image Restoration", JOSA 62(1), 1972; L.B. Lucy, "An iterative technique for the rectification of observed distributions", Astronomical Journal 79, 1974.</sub> | Blur Trail: —<br>Length (1–150): 10.0<br>Angle (-180–180): 0.0<br>Method: Wiener Filter<br>Noise (0.0001–1): 0.0100<br>Iterations (1–200): 25 |
| **Optical Deblurring** | Corrects an out of focus blur.<br><sub>Ref.: N. Wiener, "Extrapolation, Interpolation, and Smoothing of Stationary Time Series", MIT Press, 1949; R.C. Gonzalez, R.E. Woods, "Digital Image Processing", ch. 5.</sub> | Radius (0.5–40): 3.00<br>Method: Wiener Filter<br>Noise (0.0001–1): 0.0100<br>Iterations (1–200): 25 |
| **Gaussian Deblurring** | Corrects a Gaussian blur (atmospheric or sensor).<br><sub>Ref.: N. Wiener, "Extrapolation, Interpolation, and Smoothing of Stationary Time Series", MIT Press, 1949; R.C. Gonzalez, R.E. Woods, "Digital Image Processing", ch. 5.</sub> | Sigma (0.3–20): 1.50<br>Method: Wiener Filter<br>Noise (0.0001–1): 0.0100<br>Iterations (1–200): 25 |
| **Nonlinear Deblurring** | Corrects a blur with a non linear trajectory.<br><sub>Ref.: N. Wiener, "Extrapolation, Interpolation, and Smoothing of Stationary Time Series", MIT Press, 1949; R.C. Gonzalez, R.E. Woods, "Digital Image Processing", ch. 5. W.H. Richardson, "Bayesian-Based Iterative Method of Image Restoration", JOSA 62(1), 1972; L.B. Lucy, "An iterative technique for the rectification of observed distributions", Astronomical Journal 79, 1974.</sub> | Points: —<br>Noise (0.0001–1): 0.0100<br>Thickness (1–199): 1<br>Method: Wiener Filter<br>Iterations (1–200): 25 |

## Stabilization

_Stabilizes the video on a region or globally._

| Filter | Description | Parameters (defaults) |
|---|---|---|
| **Local Stabilization** | Stabilizes the video on a selected object (e.g. a license plate).<br><sub>Ref.: J.P. Lewis, "Fast Normalized Cross-Correlation", Vision Interface, 1995.</sub> | Tracked Region: —<br>Reference Frame: 0<br>Search Range (px) (4–256): 32<br>Sub-pixel Accuracy: Yes<br>Borders: Black |
| **Global Stabilization** | Stabilizes the whole frame with phase correlation.<br><sub>Ref.: C.D. Kuglin, D.C. Hines, "The phase correlation image alignment method", Proc. IEEE Conf. Cybernetics and Society, 1975.</sub> | Reference Frame: 0<br>Sub-pixel Accuracy: Yes<br>Borders: Black |

## Integrate

_Combines information of several frames._

| Filter | Description | Parameters (defaults) |
|---|---|---|
| **Frame Averaging** | Averages several frames to reduce the noise.<br><sub>Ref.: P.J. Huber, "Robust Statistics", Wiley, 1981 (sigma-clipped mean).</sub> | Frames: All Frames<br>Window Size (2–200): 5<br>Method: Mean<br>Sigma (1–5): 2.00 |
| **Temporal Smoothing** | Reduces the noise of a video by combining each frame with its neighbors (moving window); the number of frames does not change.<br><sub>Ref.: J.C. Brailean, R.P. Kleihorst, S. Efstratiadis, A.K. Katsaggelos, R.L. Lagendijk, "Noise reduction filters for dynamic image sequences: a review", Proceedings of the IEEE 83(9), 1995.</sub> | Size (2–31): 5<br>Method: Mean<br>Protect Moving Objects: Yes<br>Motion Threshold (1–100): 12.0<br>Show Protected Areas: No |
| **Super Resolution** ⏱ | Combines the frames with sub-pixel registration to increase the resolution.<br><sub>Ref.: M. Irani, S. Peleg, "Improving resolution by image registration", CVGIP: Graphical Models and Image Processing 53(3), 1991; S. Farsiu et al., "Fast and robust multiframe super resolution", IEEE Trans. Image Processing 13(10), 2004.</sub> | Scale Factor (2–4): 2<br>Registration Region (optional): —<br>Maximum Frames (2–200): 30<br>Splat Kernel: Gaussian |

## Presentation

_Annotations and presentation tools._

| Filter | Description | Parameters (defaults) |
|---|---|---|
| **Add Text** | Adds a text to the image. | Text: Text<br>Position: (20.0, 20.0)<br>Size (6–300): 32<br>Font: Sans Serif<br>Bold: Yes<br>Color: #ffffff<br>Background: Yes<br>Background Color: #000000<br>Background Opacity (0–1): 0.60 |
| **Add Shape** | Select and draw shapes on current frame. | Shape Type: Rectangle<br>Border Thickness (0–50): 3<br>Border Color: #ff2020<br>Fill Area: No<br>Fill Color: #ff2020<br>Fill Opacity (0–1): 0.30<br>Area: —<br>Line: —<br>From Frame: 0<br>To Frame (-1 = end): Last |
| **Hide Selection** | Hides a region (faces, plates of bystanders) by blurring, pixelating or filling. | Region: —<br>Shape: Rectangle<br>Mode: Pixelate<br>Strength (2–100): 16<br>Fill Color: #000000 |
| **Spotlight** | Highlights a region by dimming the rest of the image. | Region: —<br>Shape: Ellipse<br>Dimming (0–1): 0.60<br>Feather (0–200): 16<br>Border: Yes<br>Border Color: #ffd400 |
| **Magnify** | Shows a magnified inset of a region. | Region: —<br>Zoom (1–10): 2.50<br>Position: Top Right<br>Interpolation: Bicubic<br>Border (0–20): 2<br>Border Color: #ffd400 |
| **Add Timestamp** | Adds the frame number and/or time to each frame. | Format: Frame and Time<br>Start Date/Time: 2026-01-01 00:00:00.000<br>Position: Bottom Left<br>Size (8–120): 20<br>Color: #ffffff<br>Background: Yes |
| **Add Logo** | Adds a logo or watermark image. | Logo Image: —<br>Position: Top Right<br>Scale (%) (1–200): 20.0<br>Opacity (0–1): 0.85<br>Margin (0–200): 12 |
| **Add Grid** | Overlays a grid for reference. | Spacing (4–1000): 50<br>Thickness (1–10): 1<br>Color: #00ff66<br>Opacity (0–1): 0.50<br>Coordinates: No |
| **Change Frame Rate** | Changes the nominal frame rate (playback speed) without changing the frames. | Frame Rate (0.1–240): 25.000 |
| **Convert Frame Rate** | Converts the frame rate by duplicating, dropping or blending frames. | Target Frame Rate (0.1–240): 25.000<br>Method: Duplicate/Drop |
| **Reverse** | Reverses the order of the frames. | — |
| **Freeze Frame** | Holds a frame for a number of frames. | Frame: 0<br>Duration (frames) (1–100000): 50 |
