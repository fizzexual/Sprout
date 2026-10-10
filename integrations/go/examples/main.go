package main

import (
	"context"
	"fmt"
	sprouthost "github.com/fizzexual/Sprout/integrations/go"
	"os"
	"path/filepath"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: rules-host /absolute/sprout /absolute/rules.sprout")
		os.Exit(2)
	}
	executable, _ := filepath.Abs(os.Args[1])
	program, _ := filepath.Abs(os.Args[2])
	host, err := sprouthost.New(executable, sprouthost.Options{})
	if err != nil {
		panic(err)
	}
	result, err := host.Run(context.Background(), program, map[string]any{"quantity": 10, "unit_price": sprouthost.Decimal("12.50")})
	if err != nil {
		panic(err)
	}
	fmt.Println(string(result.JSON))
}
