// Package ouoratelimitextension exposes the ouoratelimit extension (the
// receiver middleware of the ouoratelimit processor, see
// ouoratelimitprocessor.ExtensionConfig) under a package of its own, because
// ocb calls NewFactory on each component's import path.
package ouoratelimitextension // import "github.com/ouo11y/ouo11y/collector/processor/ouoratelimitprocessor/ouoratelimitextension"

import (
	"go.opentelemetry.io/collector/extension"

	"github.com/ouo11y/ouo11y/collector/processor/ouoratelimitprocessor"
)

// NewFactory returns the factory for the ouoratelimit extension.
func NewFactory() extension.Factory {
	return ouoratelimitprocessor.NewExtensionFactory()
}
