package main
import "fmt"
func isPrime(n int) bool {
 if n<2 {return false}
 for d:=2; d*d<=n; d++ { if n%d==0 {return false} }
 return true
}
func main(){ c:=0; for n:=0;n<80000;n++ { if isPrime(n) {c++} }; fmt.Println(c) }
