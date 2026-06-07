import SwiftUI
import AVFoundation

/// UIView backed by AVCaptureVideoPreviewLayer. Tap-to-focus + pinch-to-zoom are
/// handled here in UIKit so we can convert layer points to device points.
final class PreviewUIView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var videoLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
}

struct CameraPreview: UIViewRepresentable {
    let controller: CameraController

    func makeCoordinator() -> Coordinator { Coordinator(controller) }

    func makeUIView(context: Context) -> PreviewUIView {
        let view = PreviewUIView()
        view.videoLayer.session = controller.session
        view.videoLayer.videoGravity = .resizeAspectFill

        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.handleTap(_:)))
        let pinch = UIPinchGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.handlePinch(_:)))
        view.addGestureRecognizer(tap)
        view.addGestureRecognizer(pinch)
        return view
    }

    func updateUIView(_ uiView: PreviewUIView, context: Context) {}

    final class Coordinator: NSObject {
        private let controller: CameraController
        private var lastScale: CGFloat = 1
        init(_ controller: CameraController) { self.controller = controller }

        @objc func handleTap(_ g: UITapGestureRecognizer) {
            guard let v = g.view as? PreviewUIView else { return }
            let point = g.location(in: v)
            let devicePoint = v.videoLayer.captureDevicePointConverted(fromLayerPoint: point)
            controller.focus(atDevicePoint: devicePoint)
        }

        @objc func handlePinch(_ g: UIPinchGestureRecognizer) {
            if g.state == .began { lastScale = 1 }
            let delta = g.scale / lastScale
            lastScale = g.scale
            controller.zoom(by: delta)
        }
    }
}
