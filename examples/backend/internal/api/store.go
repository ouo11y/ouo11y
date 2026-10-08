package api

import (
	"fmt"
	"sort"
	"sync"
)

// Product is a fake catalogue entry. Image is a placeholder path the demo
// apps resolve against their own static assets.
type Product struct {
	ID    string  `json:"id"`
	Name  string  `json:"name"`
	Price float64 `json:"price"`
	Image string  `json:"image"`
}

// CartItem is one line in a cart.
type CartItem struct {
	ProductID string  `json:"productId"`
	Name      string  `json:"name"`
	Qty       int     `json:"qty"`
	UnitPrice float64 `json:"unitPrice"`
	Subtotal  float64 `json:"subtotal"`
}

// Cart is the summary returned by the cart endpoints.
type Cart struct {
	UserID    string     `json:"userId"`
	Items     []CartItem `json:"items"`
	ItemCount int        `json:"itemCount"`
	Total     float64    `json:"total"`
}

var products = []Product{
	{ID: "p-1001", Name: "Trail Runner Shoes", Price: 129.00, Image: "/images/products/trail-runner.png"},
	{ID: "p-1002", Name: "Insulated Water Bottle", Price: 24.50, Image: "/images/products/water-bottle.png"},
	{ID: "p-1003", Name: "Merino Base Layer", Price: 79.90, Image: "/images/products/base-layer.png"},
	{ID: "p-1004", Name: "Headlamp 400lm", Price: 44.99, Image: "/images/products/headlamp.png"},
	{ID: "p-1005", Name: "Ultralight Tent", Price: 349.00, Image: "/images/products/tent.png"},
	{ID: "p-1006", Name: "Trekking Poles (pair)", Price: 89.00, Image: "/images/products/poles.png"},
}

// Store is an in-memory catalogue and per-user cart store. It is safe for
// concurrent use.
type Store struct {
	mu    sync.Mutex
	carts map[string]map[string]int // userID -> productID -> qty
	seq   int
}

// NewStore returns an empty store with the fixed product catalogue.
func NewStore() *Store {
	return &Store{carts: make(map[string]map[string]int)}
}

// Products returns the catalogue.
func (s *Store) Products() []Product {
	out := make([]Product, len(products))
	copy(out, products)
	return out
}

// Product looks a product up by id.
func (s *Store) Product(id string) (Product, bool) {
	for _, p := range products {
		if p.ID == id {
			return p, true
		}
	}
	return Product{}, false
}

// AddToCart adds qty of productID to the user's cart and returns the
// resulting summary. qty may be negative to remove.
func (s *Store) AddToCart(userID, productID string, qty int) (Cart, error) {
	if _, ok := s.Product(productID); !ok {
		return Cart{}, fmt.Errorf("unknown product %q", productID)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	cart := s.carts[userID]
	if cart == nil {
		cart = make(map[string]int)
		s.carts[userID] = cart
	}
	cart[productID] += qty
	if cart[productID] <= 0 {
		delete(cart, productID)
	}
	return s.summaryLocked(userID), nil
}

// Cart returns the user's cart summary.
func (s *Store) Cart(userID string) Cart {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.summaryLocked(userID)
}

// Checkout empties the user's cart and returns an order id and total.
func (s *Store) Checkout(userID string) (orderID string, total float64, items int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.summaryLocked(userID)
	delete(s.carts, userID)
	s.seq++
	return fmt.Sprintf("ord-%06d", s.seq), c.Total, c.ItemCount
}

func (s *Store) summaryLocked(userID string) Cart {
	c := Cart{UserID: userID, Items: []CartItem{}}
	ids := make([]string, 0, len(s.carts[userID]))
	for id := range s.carts[userID] {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		p, _ := s.Product(id)
		qty := s.carts[userID][id]
		item := CartItem{ProductID: id, Name: p.Name, Qty: qty, UnitPrice: p.Price, Subtotal: round2(p.Price * float64(qty))}
		c.Items = append(c.Items, item)
		c.ItemCount += qty
		c.Total += item.Subtotal
	}
	c.Total = round2(c.Total)
	return c
}

func round2(f float64) float64 {
	return float64(int64(f*100+0.5)) / 100
}
