package main
import "fmt"
func main(){
 total:=0
 i:=0
 for k:=0;k<5000000;k++ { total+=i; i++ }
 fmt.Println(total)
}
