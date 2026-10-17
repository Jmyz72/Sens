//! Native OS text recognition. One backend per platform behind `recognize`.
//! Only the extracted text leaves this module; the image is never stored.

use crate::error::{AppError, AppResult};

pub fn recognize(image: &[u8]) -> AppResult<String> {
    finish(platform::recognize(image)?)
}

fn finish(text: String) -> AppResult<String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err(AppError::Ai("ocr_empty", "No text was found in that image.".into()));
    }
    Ok(text)
}

fn unavailable(message: impl Into<String>) -> AppError {
    AppError::Ai("ocr_unavailable", message.into())
}

#[cfg(target_os = "macos")]
mod platform {
    use super::unavailable;
    use crate::error::AppResult;
    use objc2::rc::Retained;
    use objc2::AnyThread;
    use objc2_foundation::{NSArray, NSData, NSDictionary};
    use objc2_vision::{
        VNImageRequestHandler, VNRecognizeTextRequest, VNRecognizedTextObservation, VNRequest,
        VNRequestTextRecognitionLevel,
    };

    pub fn recognize(image: &[u8]) -> AppResult<String> {
        let data = NSData::with_bytes(image);
        let handler = VNImageRequestHandler::initWithData_options(
            VNImageRequestHandler::alloc(),
            &data,
            &NSDictionary::new(),
        );
        let request = VNRecognizeTextRequest::new();
        request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
        request.setUsesLanguageCorrection(true);
        let as_request: Retained<VNRequest> = Retained::into_super(Retained::into_super(request.clone()));
        let requests = NSArray::from_retained_slice(&[as_request]);
        handler
            .performRequests_error(&requests)
            .map_err(|e| unavailable(format!("Could not read the image: {}", e.localizedDescription())))?;
        let mut lines = Vec::new();
        if let Some(results) = request.results() {
            for obs in results.iter() {
                let obs: Retained<VNRecognizedTextObservation> = unsafe { Retained::cast_unchecked(obs) };
                if let Some(best) = obs.topCandidates(1).iter().next() {
                    lines.push(best.string().to_string());
                }
            }
        }
        Ok(lines.join("\n"))
    }
}

#[cfg(windows)]
mod platform {
    use super::unavailable;
    use crate::error::AppResult;
    use windows::Graphics::Imaging::BitmapDecoder;
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};

    fn run(image: &[u8]) -> windows::core::Result<String> {
        let stream = InMemoryRandomAccessStream::new()?;
        let writer = DataWriter::CreateDataWriter(&stream)?;
        writer.WriteBytes(image)?;
        writer.StoreAsync()?.get()?;
        writer.DetachStream()?;
        stream.Seek(0)?;
        let decoder = BitmapDecoder::CreateAsync(&stream)?.get()?;
        let bitmap = decoder.GetSoftwareBitmapAsync()?.get()?;
        let engine = OcrEngine::TryCreateFromUserProfileLanguages()?;
        let result = engine.RecognizeAsync(&bitmap)?.get()?;
        let mut lines = Vec::new();
        for line in result.Lines()? {
            lines.push(line.Text()?.to_string());
        }
        Ok(lines.join("\n"))
    }

    pub fn recognize(image: &[u8]) -> AppResult<String> {
        run(image).map_err(|e| unavailable(format!("Could not read the image: {e}")))
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    use super::unavailable;
    use crate::error::AppResult;

    pub fn recognize(_image: &[u8]) -> AppResult<String> {
        Err(unavailable("Text recognition is available on macOS and Windows only."))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_bytes_that_are_not_an_image() {
        assert!(recognize(&[0, 1, 2, 3]).is_err());
    }

    #[test]
    fn empty_text_is_reported_as_ocr_empty() {
        match finish(String::from("  \n ")) {
            Err(AppError::Ai(code, _)) => assert_eq!(code, "ocr_empty"),
            other => panic!("expected ocr_empty, got {other:?}"),
        }
        assert_eq!(finish(" hello \n".into()).unwrap(), "hello");
    }

    /// Manual smoke test: `SENS_OCR_SAMPLE=/path/to/receipt.png cargo test --lib -- --ignored recognizes_a_sample`
    #[test]
    #[ignore]
    fn recognizes_a_sample_image() {
        let path = std::env::var("SENS_OCR_SAMPLE").expect("set SENS_OCR_SAMPLE to an image path");
        let text = recognize(&std::fs::read(path).unwrap()).unwrap();
        println!("{text}");
        assert!(!text.is_empty());
    }
}
