import OuoSDK
import SwiftUI
import UIKit

/// Home (UIKit): automatic screen (named by `OuoScreenNaming`), reports full display, the button to Products.
final class HomeViewController: UIViewController, OuoScreenNaming {
    var ouoScreenName: String? { "Home" }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Home"
        view.backgroundColor = .systemBackground
        let greeting = UILabel()
        greeting.text = "Hello, Ada Lovelace"
        let open = UIButton(type: .system)
        open.setTitle("Products", for: .normal)
        open.accessibilityIdentifier = "open-products"
        open.addAction(UIAction { [weak self] _ in self?.navigationController?.pushViewController(Products.controller(), animated: true) }, for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [greeting, open])
        stack.axis = .vertical
        stack.spacing = 24
        stack.frame = CGRect(x: 24, y: 160, width: 320, height: 120)
        view.addSubview(stack)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        Journey.homeAppeared()
        // The content is all there once it appears: TTFD (C4.2).
        Ouo.reportFullyDisplayed()
    }
}

/// Products (SwiftUI): `.ouoScreen`, a masked card and an unmasked total.
struct Products: View {
    var onCart: () -> Void

    static func controller() -> UIViewController {
        let host = UIHostingController(rootView: AnyView(EmptyView()))
        host.rootView = AnyView(Products { [weak host] in host?.navigationController?.pushViewController(CartViewController(), animated: true) })
        host.title = "Products"
        return host
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Espresso cup, 4.50").font(.title3)
            Text("Card ending 4242").ouoMask()
            Text("Total 4.50").ouoUnmask()
            Image(systemName: "cup.and.saucer.fill").font(.largeTitle)
            Button("Add to cart", action: onCart).accessibilityIdentifier("add-to-cart")
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .ouoScreen("Products")
    }
}

/// Cart (UIKit): a promo code input (masked), a horizontally scrolling item list to swipe, a checkout
/// button whose request runs inside a span.
final class CartViewController: UIViewController, OuoScreenNaming {
    var ouoScreenName: String? { "Cart" }
    let list = UIScrollView()

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Cart"
        view.backgroundColor = .systemBackground
        let promo = UITextField(frame: CGRect(x: 24, y: 140, width: 320, height: 40))
        promo.placeholder = "Promo code"
        promo.text = "SECRET-42"
        promo.borderStyle = .roundedRect
        list.frame = CGRect(x: 24, y: 200, width: 320, height: 80)
        list.accessibilityIdentifier = "cart-items"
        list.contentSize = CGSize(width: 960, height: 80)
        for i in 0..<3 {
            let item = UILabel(frame: CGRect(x: CGFloat(i) * 320 + 8, y: 20, width: 300, height: 40))
            item.text = "Item \(i + 1)"
            list.addSubview(item)
        }
        let checkout = UIButton(type: .system)
        checkout.setTitle("Checkout", for: .normal)
        checkout.accessibilityIdentifier = "checkout"
        checkout.frame = CGRect(x: 24, y: 300, width: 320, height: 44)
        checkout.addAction(UIAction { _ in Journey.checkout() }, for: .touchUpInside)
        [promo, list, checkout].forEach(view.addSubview)
    }
}
