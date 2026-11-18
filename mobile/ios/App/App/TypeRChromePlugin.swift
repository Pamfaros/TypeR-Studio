import Capacitor
import UIKit

// The top bar and the tabs of the app on an iPhone held upright, drawn by the system instead of
// the page: Liquid Glass on iOS 26 and later, the bars of its time before. The page says what
// they show and is told what was pressed (web/mobile.js, web/touch.js); it draws everything
// else, and makes room for them from the measures given back here.
@objc(TypeRChromePlugin)
class TypeRChromePlugin: CAPPlugin, CAPBridgedPlugin, UITabBarDelegate, UINavigationBarDelegate {
    let identifier = "TypeRChromePlugin"
    let jsName = "TypeRChrome"
    let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise)]

    // The page's panels, as SF Symbols
    private static let symbols = [
        "tools": "wand.and.stars", "script": "doc.text", "styles": "textformat", "layers": "square.3.layers.3d",
        "text": "character", "lines": "text.alignleft", "more": "ellipsis"
    ]

    private let top = UINavigationBar()
    private let tabs = UITabBar()
    private let item = UINavigationItem()
    private let pages = UIButton(type: .system)
    // The room the page's name takes in the bar: its own width, up to what the buttons leave it
    private let nameBox = UIView()
    private var nameWidth: NSLayoutConstraint!
    private var back: UIBarButtonItem!
    private var forward: UIBarButtonItem!
    private var undo: UIBarButtonItem!
    private var redo: UIBarButtonItem!
    private var export: UIBarButtonItem!
    private var name: UIBarButtonItem!
    private var built = false
    private var tabIds: [String] = []
    private var tabLabels: [String] = []
    private var pager = false

    private func say(_ what: String, _ id: String? = nil) {
        var data: [String: Any] = ["what": what]
        if let id = id { data["id"] = id }
        notifyListeners("act", data: data)
    }

    private func button(_ symbol: String, _ what: String) -> UIBarButtonItem {
        UIBarButtonItem(image: UIImage(systemName: symbol), primaryAction: UIAction { [weak self] _ in self?.say(what) })
    }

    private func build(in view: UIView) {
        built = true
        back = button("chevron.left", "back")
        forward = button("chevron.right", "forward")
        undo = button("arrow.uturn.backward", "undo")
        redo = button("arrow.uturn.forward", "redo")
        export = button("square.and.arrow.up", "export")
        if #available(iOS 26.0, *) {
            // The one thing a page is opened for: a glass of its own, in the app's colour
            export.style = .prominent
            export.sharesBackground = false
        } else {
            export.style = .done
        }
        item.rightBarButtonItems = [export, redo, undo]

        // The page's name and its place in the chapter, which open the pages when touched:
        // between the two arrows, in the same glass
        var look = UIButton.Configuration.plain()
        look.titleAlignment = .leading
        look.titleLineBreakMode = .byTruncatingMiddle
        look.subtitleLineBreakMode = .byTruncatingTail
        look.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 10, bottom: 0, trailing: 10)
        look.titlePadding = 0
        look.baseForegroundColor = .label
        look.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var next = attributes
            next.font = .systemFont(ofSize: 15, weight: .semibold)
            return next
        }
        look.subtitleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
            var next = attributes
            next.font = .systemFont(ofSize: 11, weight: .medium)
            next.foregroundColor = .secondaryLabel
            return next
        }
        pages.configuration = look
        pages.addAction(UIAction { [weak self] _ in self?.say("pages") }, for: .touchUpInside)
        pages.translatesAutoresizingMaskIntoConstraints = false
        nameBox.translatesAutoresizingMaskIntoConstraints = false
        nameBox.addSubview(pages)
        nameWidth = nameBox.widthAnchor.constraint(equalToConstant: 120)
        NSLayoutConstraint.activate([
            nameWidth,
            nameBox.heightAnchor.constraint(equalToConstant: 44),
            pages.leadingAnchor.constraint(equalTo: nameBox.leadingAnchor),
            pages.trailingAnchor.constraint(equalTo: nameBox.trailingAnchor),
            pages.topAnchor.constraint(equalTo: nameBox.topAnchor),
            pages.bottomAnchor.constraint(equalTo: nameBox.bottomAnchor)
        ])
        name = UIBarButtonItem(customView: nameBox)

        top.delegate = self
        top.setItems([item], animated: false)
        tabs.delegate = self
        for bar in [top, tabs] as [UIView] {
            bar.translatesAutoresizingMaskIntoConstraints = false
            bar.isHidden = true
            view.addSubview(bar)
        }
        NSLayoutConstraint.activate([
            top.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            top.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            top.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            tabs.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            tabs.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            tabs.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
    }

    // Under the clock too
    func position(for bar: UIBarPositioning) -> UIBarPosition { .topAttached }

    func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
        guard tabIds.indices.contains(item.tag) else { return }
        say("tab", tabIds[item.tag])
    }

    @objc func update(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let view = self.bridge?.viewController?.view else {
                call.resolve(["top": 0, "bottom": 0])
                return
            }
            let shown = call.getBool("shown") ?? false
            if !self.built {
                if !shown {
                    call.resolve(["top": 0, "bottom": 0])
                    return
                }
                self.build(in: view)
            }
            self.top.isHidden = !shown
            self.tabs.isHidden = !shown
            if shown { self.show(call) }
            view.layoutIfNeeded()
            call.resolve([
                "top": shown ? self.top.frame.maxY : 0,
                "bottom": shown ? view.bounds.height - self.tabs.frame.minY : 0
            ])
        }
    }

    private func show(_ call: CAPPluginCall) {
        let style: UIUserInterfaceStyle = (call.getBool("light") ?? false) ? .light : .dark
        if let tint = UIColor.capacitor.color(fromHex: call.getString("tint") ?? "") {
            top.tintColor = tint
            tabs.tintColor = tint
        }
        for bar in [top, tabs] as [UIView] { bar.overrideUserInterfaceStyle = style }

        // A dialog, a menu or the busy veil of the page takes the whole screen: the bars step back
        let covered = call.getBool("covered") ?? false
        if (top.alpha == 0) != covered {
            UIView.animate(withDuration: 0.18) {
                self.top.alpha = covered ? 0 : 1
                self.tabs.alpha = covered ? 0 : 1
            }
            top.isUserInteractionEnabled = !covered
            tabs.isUserInteractionEnabled = !covered
        }

        var look = pages.configuration
        look?.title = call.getString("title") ?? ""
        let count = call.getString("count") ?? ""
        look?.subtitle = count.isEmpty ? nil : count
        pages.configuration = look
        let labels = call.getObject("labels") ?? [:]
        pages.accessibilityLabel = [labels["pages"] as? String, call.getString("title"), count].compactMap { $0 }.joined(separator: ", ")
        pages.isEnabled = call.getBool("export") ?? false
        for (one, name) in [(back, "back"), (forward, "forward"), (undo, "undo"), (redo, "redo"), (export, "export")] {
            one?.isEnabled = call.getBool(name) ?? false
            one?.accessibilityLabel = labels[name] as? String
        }
        // The arrows from page to page, when there is more than one
        let pager = call.getBool("pager") ?? false
        // What Undo, Redo, Export and the margins take, then the two arrows
        // A long name is cut short before one of them is folded away
        let room = min(top.bounds.width, top.safeAreaLayoutGuide.layoutFrame.width) - 193 - (pager ? 88 : 0)
        let wide = ((call.getString("title") ?? "") as NSString).size(withAttributes: [.font: UIFont.systemFont(ofSize: 15, weight: .semibold)]).width
        nameWidth.constant = min(max(72, min(150, room)), max(44, ceil(wide) + 22))
        if pager != self.pager || item.leftBarButtonItems == nil {
            self.pager = pager
            item.leftBarButtonItems = pager ? [back, name, forward] : [name]
        }

        let list = call.getArray("tabs", JSObject.self) ?? []
        let ids = list.map { $0["id"] as? String ?? "" }
        let names = list.map { $0["label"] as? String ?? "" }
        if ids != tabIds || names != tabLabels {
            tabIds = ids
            tabLabels = names
            tabs.setItems(ids.enumerated().map { index, id in
                UITabBarItem(title: names[index], image: UIImage(systemName: TypeRChromePlugin.symbols[id] ?? "circle"), tag: index)
            }, animated: false)
        }
        let current = call.getString("current") ?? ""
        let chosen = tabIds.firstIndex(of: current).flatMap { index in tabs.items?[index] }
        if tabs.selectedItem !== chosen { tabs.selectedItem = chosen }
    }
}
