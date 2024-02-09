// Example: Loading a test program into memory
// Let's assume 0xA9 is the opcode for LDA (Immediate)
// and 0x69 is the opcode for ADC (Immediate)
CPU.Memory[0x0000] = 0xA9; // LDA (Immediate)
CPU.Memory[0x0001] = 0x09; // Operand (5)
CPU.Memory[0x0002] = 0x69; // ADC (Immediate)
CPU.Memory[0x0003] = 0x09; // Operand (3)

// Set the program counter to the start of the test program
CPU.PC = 0x0000;

for (let i = 0; i < 2; i++) { // Execute two instructions for this test
    CPU.decodeAndExecute();
}
// Check the state of the CPU
console.log("Accumulator:", CPU.A); // Expected: 8 (5 + 3)
console.log("Zero Flag:", CPU.Flags.ZeroFlag); // Expected: false
console.log("Negative Flag:", CPU.Flags.NegativeFlag); // Expected: false
console.log("Carry Flag:", CPU.Flags.CarryFlag); // Expected: false